import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineMutator, defineMutators } from "@nizhal/kernel";
import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";
import { createCollection, createLiveQueryCollection } from "@tanstack/db";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNizhalClient,
  createNizhalMutators,
  createSerializedWaSqliteDatabase,
  nizhalCollectionOptions,
  waSqlitePersistence,
} from "../src/index.js";
import { NodeFileVFS } from "./node-file-vfs.js";

interface NoteRow {
  id: string;
  owner_id: string;
  body: string;
  tag: string | null;
}

const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
  tag: text("tag"),
});

const noteMutators = defineMutators({
  addNote: defineMutator({ parse: parseAddNote }, async ({ tx }, args) => {
    await tx.insert(notes).values(args);
    return { affectedBuckets: [args.owner_id] };
  }),
  updateNote: defineMutator({ parse: parseUpdateNote }, async ({ tx }, args) => {
    await tx.update(notes, { id: args.id }).set({ body: args.body });
    return { affectedBuckets: ["owner-1"] };
  }),
});

const environments: WaSqliteEnv[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const environment of environments.splice(0)) {
    await environment.close();
    await rm(environment.rootDir, { recursive: true, force: true });
  }
});

describe("local-first default", () => {
  it("test:cold-offline-first — no-server writes persist and remain live after a cold restart", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const environment = await createWaSqliteEnv();
    environments.push(environment);

    const db1 = await environment.openDatabase("cold-local.db");
    const store1 = await waSqlitePersistence({ database: db1 });
    const echo1 = createNizhalClient({});
    const collection1 = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        echo: echo1,
        getKey: (row) => row.id,
        persistence: store1.persistence,
      }),
    );
    const { mutate, executor, dispose } = createNizhalMutators({
      collections: { notes: collection1 },
      echo: echo1,
      actor: { userId: "user-1", ownerId: "owner-1" },
      mutators: noteMutators,
      outboxStorage: store1.outboxStorage,
      deadLetterStorage: store1.deadLetterStorage,
      clientID: store1.clientId,
    });

    await collection1.preload();
    await executor.waitForInit();
    const live1 = createLiveQueryCollection((query) =>
      query.from({ note: collection1 }).select(({ note }) => ({ ...note })),
    );
    await live1.preload();
    let liveNotifications = 0;
    const subscription = live1.subscribeChanges(() => {
      liveNotifications += 1;
    });

    mutate.addNote({
      id: "note-local",
      owner_id: "owner-1",
      body: "written without a server",
      tag: null,
    });

    await waitFor(() => live1.toArray.some((row) => row.id === "note-local"));
    await waitFor(() => liveNotifications > 0);
    await waitFor(async () => (await executor.peekOutbox()).length === 0);
    expect(fetchSpy).not.toHaveBeenCalled();

    subscription.unsubscribe();
    await live1.cleanup();
    await collection1.cleanup();
    await dispose();
    await store1.dispose();
    await db1.close();

    const db2 = await environment.openDatabase("cold-local.db");
    const store2 = await waSqlitePersistence({ database: db2 });
    const echo2 = createNizhalClient({});
    const collection2 = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        echo: echo2,
        getKey: (row) => row.id,
        persistence: store2.persistence,
      }),
    );
    await collection2.preload();
    const live2 = createLiveQueryCollection((query) =>
      query.from({ note: collection2 }).select(({ note }) => ({ ...note })),
    );
    await live2.preload();

    expect(live2.toArray[0]).toMatchObject({
      id: "note-local",
      owner_id: "owner-1",
      body: "written without a server",
      tag: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    await live2.cleanup();
    await collection2.cleanup();
    await store2.dispose();
    await db2.close();
  });

  it("test:pull-as-merge-ack-barrier — dirty rows survive interleaved pull and reconcile after ack", async () => {
    let onMessage: ((message: string) => void) | undefined;
    let pullPhase: "bootstrap" | "interleaved" | "ack" = "bootstrap";
    let resolvePush: ((response: Response) => void) | undefined;
    const pushResponse = new Promise<Response>((resolve) => {
      resolvePush = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/sync/push")) return pushResponse;
        if (!url.endsWith("/sync/pull")) throw new Error(`unexpected request: ${url}`);

        if (pullPhase === "bootstrap") {
          return jsonResponse(
            pullResult("cursor-1", [
              { id: "note-1", owner_id: "owner-1", body: "original", tag: null },
              { id: "note-2", owner_id: "owner-1", body: "second", tag: null },
            ]),
          );
        }
        if (pullPhase === "interleaved") {
          return jsonResponse(
            pullResult("cursor-2", [
              {
                id: "note-1",
                owner_id: "owner-1",
                body: "conflicting server body",
                tag: "server-tag",
              },
              { id: "note-2", owner_id: "owner-1", body: "server second", tag: null },
            ]),
          );
        }
        return jsonResponse(
          pullResult("cursor-3", [
            {
              id: "note-1",
              owner_id: "owner-1",
              body: "local edit",
              tag: "server-tag",
            },
            { id: "note-2", owner_id: "owner-1", body: "server second", tag: null },
          ]),
        );
      }),
    );

    const echo = createNizhalClient({
      server: "https://sync.example",
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: {
        subscribe: (_buckets, handler) => {
          onMessage = handler;
          return () => {};
        },
      },
    });
    const collection = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        echo,
        getKey: (row) => row.id,
      }),
    );
    const { mutate, executor, dispose } = createNizhalMutators({
      collections: { notes: collection },
      echo,
      actor: { userId: "user-1", ownerId: "owner-1" },
      mutators: noteMutators,
    });

    await collection.preload();
    await executor.waitForInit();
    await waitFor(() => collection.toArray.length === 2);

    mutate.updateNote({ id: "note-1", body: "local edit" });
    await waitFor(() => collection.get("note-1")?.body === "local edit");

    pullPhase = "interleaved";
    onMessage?.("repull:owner-1");
    await waitFor(() => collection.get("note-2")?.body === "server second");
    expect(collection.get("note-1")).toMatchObject({ body: "local edit", tag: null });
    expect(echo.syncStatus().lastError?.phase).toBe("conflict");

    pullPhase = "ack";
    resolvePush?.(jsonResponse({ ok: true }));
    await waitFor(async () => (await executor.peekOutbox()).length === 0);
    await waitFor(() => collection.get("note-1")?.tag === "server-tag");
    expect(collection.get("note-1")).toMatchObject({ body: "local edit", tag: "server-tag" });

    await collection.cleanup();
    await dispose();
  });

  it("test:server-authoritative-opt-in — pull keeps replacement semantics", async () => {
    let onMessage: ((message: string) => void) | undefined;
    let replacement = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          pullResult(replacement ? "cursor-2" : "cursor-1", [
            {
              id: "note-1",
              owner_id: "owner-1",
              body: replacement ? "authoritative replacement" : "initial",
              tag: replacement ? "server" : null,
            },
          ]),
        ),
      ),
    );
    const echo = createNizhalClient({
      server: "https://sync.example",
      mode: "server-authoritative",
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: {
        subscribe: (_buckets, handler) => {
          onMessage = handler;
          return () => {};
        },
      },
    });
    const collection = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        mode: "server-authoritative",
        echo,
        getKey: (row) => row.id,
      }),
    );

    await collection.preload();
    await waitFor(() => collection.get("note-1")?.body === "initial");
    replacement = true;
    onMessage?.("repull:owner-1");
    await waitFor(() => collection.get("note-1")?.body === "authoritative replacement");
    expect(collection.get("note-1")).toMatchObject({
      id: "note-1",
      owner_id: "owner-1",
      body: "authoritative replacement",
      tag: "server",
    });

    await collection.cleanup();
  });
});

function pullResult(cursor: string, rows: NoteRow[]) {
  return {
    changed: [{ table: "notes", rows }],
    tombstoned: [],
    removed: [],
    removedBuckets: [],
    cursor,
    hasMore: false,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function parseAddNote(input: unknown): NoteRow {
  if (typeof input !== "object" || input === null) throw new Error("invalid note");
  const value = input as Partial<NoteRow>;
  if (
    typeof value.id !== "string" ||
    typeof value.owner_id !== "string" ||
    typeof value.body !== "string" ||
    !(typeof value.tag === "string" || value.tag === null)
  ) {
    throw new Error("invalid note");
  }
  return value as NoteRow;
}

function parseUpdateNote(input: unknown): { id: string; body: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { id?: unknown }).id === "string" &&
    typeof (input as { body?: unknown }).body === "string"
  ) {
    return input as { id: string; body: string };
  }
  throw new Error("invalid update note");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface WaSqliteApi {
  vfs_register(vfs: unknown, makeDefault: boolean): void;
  open_v2(name: string, flags?: number, vfsName?: string): Promise<number>;
  close(db: number): Promise<void>;
  statements(db: number, sql: string): AsyncIterable<number>;
  bind_collection(statement: number, params: ReadonlyArray<unknown>): void;
  column_names(statement: number): ReadonlyArray<string>;
  step(statement: number): Promise<number>;
  row(statement: number): ReadonlyArray<unknown>;
}

interface WaSqliteEnv {
  rootDir: string;
  openDatabase(name: string): Promise<BrowserWASQLiteDatabase & { close(): Promise<void> }>;
  close(): Promise<void>;
}

async function createWaSqliteEnv(): Promise<WaSqliteEnv> {
  const rootDir = await mkdtemp(join(tmpdir(), "nizhal-local-first-"));
  const [{ default: SQLiteESMFactory }, SQLite] = await Promise.all([
    import("wa-sqlite/dist/wa-sqlite.mjs"),
    import("wa-sqlite"),
  ]);
  const wasmBinary = await readFile(
    new URL("../node_modules/wa-sqlite/dist/wa-sqlite.wasm", import.meta.url),
  );
  const module = await SQLiteESMFactory({ wasmBinary });
  const sqliteModule = SQLite as {
    Factory: (module: unknown) => WaSqliteApi;
    SQLITE_ROW: number;
    SQLITE_DONE: number;
  };
  const sqlite3 = sqliteModule.Factory(module);
  const vfs = new NodeFileVFS(rootDir);
  sqlite3.vfs_register(vfs, false);
  return {
    rootDir,
    async openDatabase(name) {
      const dbId = await sqlite3.open_v2(name, 0x2 | 0x4, vfs.name);
      return createSerializedWaSqliteDatabase({
        sqlite3,
        dbId,
        sqliteRow: sqliteModule.SQLITE_ROW,
        sqliteDone: sqliteModule.SQLITE_DONE,
      });
    },
    async close() {},
  };
}
