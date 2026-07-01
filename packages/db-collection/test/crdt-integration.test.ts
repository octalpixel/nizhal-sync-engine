import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { crdtText, defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
import type { RealtimeAdapter } from "@nizhal/server/adapters";
import { postgresStorage } from "@nizhal/server/adapters";
import { createCollection } from "@tanstack/db";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyCrdtUpdate,
  crdtFieldBytes,
  crdtTextContent,
  createCrdtText,
  createNizhalClient,
  createNizhalMutators,
  encodeCrdtUpdate,
  nizhalCollectionOptions,
} from "../src/index.js";

interface DocumentRow {
  id: string;
  owner_id: string;
  title: string;
  body: string;
}

const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("documents").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve() {
    return { userId: "user-1", ownerId: "owner-1" };
  },
};

const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  title: text("title").notNull(),
  body: crdtText("body").notNull(),
});

const openDbs: PGlite[] = [];
const openHarnesses: TestHarness[] = [];

describe("@nizhal/db-collection CRDT integration", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
    for (const harness of openHarnesses.splice(0)) harness.close();
  });

  it("two clients concurrently edit the same CRDT text field and converge after sync", async () => {
    const harness = await createHarness();
    const clientA = createClientStack(harness, "owner-1");
    const clientB = createClientStack(harness, "owner-1");

    await Promise.all([clientA.collection.preload(), clientB.collection.preload()]);
    await Promise.all([clientA.executor.waitForInit(), clientB.executor.waitForInit()]);

    const docId = "shared-doc";
    clientA.mutate.createDoc({
      documentId: docId,
      title: "Shared",
      bodyUpdate: base64Update(createCrdtText("")),
    });

    await waitFor(async () => {
      const rows = await harness.db.query<{ id: string }>(
        "select id from documents where id = $1",
        [docId],
      );
      return rows.rows.length === 1;
    });

    await waitFor(() => clientB.collection.toArray.some((r) => r.id === docId));

    const docA = createCrdtText("");
    const docB = createCrdtText("");

    const seedRow = clientB.collection.toArray.find((r) => r.id === docId);
    applyCrdtUpdate(docA, crdtFieldBytes(seedRow?.body));
    applyCrdtUpdate(docB, crdtFieldBytes(seedRow?.body));

    docA.getText("echo:text").insert(0, "Hello ");
    docB.getText("echo:text").insert(0, "World");

    const updateA = base64Update(docA);
    const updateB = base64Update(docB);
    clientA.mutate.editBody({ documentId: docId, bodyUpdate: updateA });
    clientB.mutate.editBody({ documentId: docId, bodyUpdate: updateB });

    await waitFor(async () => {
      const rows = await harness.db.query<{ body: Uint8Array }>(
        "select body from documents where id = $1",
        [docId],
      );
      const text = decodeText(rows.rows[0]?.body);
      return text.includes("Hello ") && text.includes("World");
    });

    await clientA.echo.pull({ cursor: "", syncRule: "ownerBucket" });
    await clientB.echo.pull({ cursor: "", syncRule: "ownerBucket" });

    const rowA = clientA.collection.toArray.find((r) => r.id === docId);
    const rowB = clientB.collection.toArray.find((r) => r.id === docId);
    applyCrdtUpdate(docA, crdtFieldBytes(rowA?.body));
    applyCrdtUpdate(docB, crdtFieldBytes(rowB?.body));

    const textA = crdtTextContent(docA);
    const textB = crdtTextContent(docB);

    expect(textA).toBe(textB);
    expect(textA).toContain("Hello ");
    expect(textA).toContain("World");
  });
});

function createClientStack(harness: TestHarness, ownerId: string) {
  const echo = createNizhalClient({
    server: harness.baseUrl,
    subscribeSource: {
      subscribe: (buckets, onMessage) => harness.realtime.subscribe(buckets, { send: onMessage }),
    },
    bucketsForSyncRule: () => [ownerId],
  });

  const collection = createCollection(
    nizhalCollectionOptions<DocumentRow>({
      name: "documents",
      syncRule: "ownerBucket",
      echo,
      bucketField: "owner_id",
    }),
  );

  const { mutate, executor } = createNizhalMutators({
    collections: { documents: collection },
    echo,
    actor: { userId: "user-1", ownerId },
    mutators: {
      createDoc: testMutators.createDoc,
      editBody: testMutators.editBody,
    },
  });

  return { collection, mutate, executor, echo };
}

interface TestHarness {
  baseUrl: string;
  db: PGlite;
  realtime: RealtimeAdapter;
  close: () => void;
}

async function createHarness(): Promise<TestHarness> {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await db.exec(`
    create table documents (
      id text primary key,
      owner_id text not null,
      title text not null,
      body bytea not null
    );
  `);
  await storage.provision({
    schema: { documents: { table: documents, merge: "field" } },
    syncRules,
  });

  const realtime = inProcessRealtime();
  const mutators = defineMutators({
    createDoc: testMutators.createDoc,
    editBody: testMutators.editBody,
  });

  const server = createNizhalServer({
    db: "postgres://unused",
    schema: { documents: { table: documents, merge: "field" } },
    mutators,
    syncRules,
    auth,
    storage,
    realtime,
  });

  const listener = await serveFetch(server.app.fetch);
  const harness: TestHarness = {
    baseUrl: listener.baseUrl,
    db,
    realtime,
    close: listener.close,
  };
  openHarnesses.push(harness);
  return harness;
}

const testMutators = {
  createDoc: defineMutator({ parse: parseCreateDoc }, async ({ tx, actor, location }, args) => {
    await tx.insert(documents).values({
      id: args.documentId,
      owner_id: actor.ownerId,
      title: args.title,
      body: location === "client" ? args.bodyUpdate : Buffer.from(args.bodyUpdate, "base64"),
    });
    return { affectedBuckets: [actor.ownerId] };
  }),
  editBody: defineMutator({ parse: parseEditBody }, async ({ tx, actor }, args) => {
    await tx
      .update(documents, { id: args.documentId })
      .set({ body: Buffer.from(args.bodyUpdate, "base64") });
    return { affectedBuckets: [actor.ownerId] };
  }),
};

function parseCreateDoc(input: unknown): { documentId: string; title: string; bodyUpdate: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { documentId?: unknown }).documentId === "string" &&
    typeof (input as { title?: unknown }).title === "string" &&
    typeof (input as { bodyUpdate?: unknown }).bodyUpdate === "string"
  ) {
    return input as { documentId: string; title: string; bodyUpdate: string };
  }
  throw new Error("invalid createDoc input");
}

function parseEditBody(input: unknown): { documentId: string; bodyUpdate: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { documentId?: unknown }).documentId === "string" &&
    typeof (input as { bodyUpdate?: unknown }).bodyUpdate === "string"
  ) {
    return input as { documentId: string; bodyUpdate: string };
  }
  throw new Error("invalid editBody input");
}

function base64Update(doc: Y.Doc): string {
  return Buffer.from(encodeCrdtUpdate(doc)).toString("base64");
}

function decodeText(bytes: Uint8Array | Buffer | number[]): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(bytes));
  return doc.getText("echo:text").toString();
}

function inProcessRealtime(): RealtimeAdapter {
  const registry = new Map<string, Set<{ send: (data: string) => void }>>();
  return {
    publish(bucket) {
      const subs = registry.get(bucket);
      if (!subs) return;
      for (const socket of subs) socket.send(`repull:${bucket}`);
    },
    subscribe(buckets, socket) {
      for (const bucket of buckets) {
        let set = registry.get(bucket);
        if (!set) {
          set = new Set();
          registry.set(bucket, set);
        }
        set.add(socket);
      }
      return () => {
        for (const bucket of buckets) registry.get(bucket)?.delete(socket);
      };
    },
  };
}

function serveFetch(fetchFn: typeof fetch): Promise<{ baseUrl: string; close: () => void }> {
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = `http://${host}${req.url ?? "/"}`;
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const init: RequestInit = { method, headers: req.headers as HeadersInit };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fetchFn(new Request(url, init))
        .then(async (response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((error: Error) => {
          res.statusCode = 500;
          res.end(error.message);
        });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
