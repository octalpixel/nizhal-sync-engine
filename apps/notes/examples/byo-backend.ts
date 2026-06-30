import { serve } from "@hono/node-server";
import {
  type NizhalPullRequest,
  type NizhalPullResponse,
  type NizhalPushRequest,
  type NizhalPushResponse,
  type NizhalSyncTarget,
  NizhalSyncTargetError,
  createNizhalClient,
  createNizhalMutators,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { Hono } from "hono";
import { addNoteInput, deleteNoteInput, notesMutators } from "../src/mutators.js";

const OWNER_ID = "owner-1";

interface BackendNote {
  [key: string]: unknown;
  id: string;
  owner_id: string;
  title: string;
  body: string;
}

type Change =
  | { sequence: number; type: "upsert"; row: BackendNote }
  | { sequence: number; type: "delete"; ownerId: string; id: string };

function createBrownfieldBackend() {
  const app = new Hono();
  const notes = new Map<string, BackendNote>();
  const changes: Change[] = [];
  const appliedMutations = new Set<string>();
  let sequence = 0;
  let duplicatePushes = 0;

  app.post("/nizhal/push", async (context) => {
    const request = await context.req.json<NizhalPushRequest>();
    if (!request.clientMutationId || !request.name) {
      return context.json({ status: "rejected", error: "invalid mutation envelope" }, 400);
    }
    if (appliedMutations.has(request.clientMutationId)) {
      duplicatePushes += 1;
      return context.json<NizhalPushResponse>({ status: "duplicate" });
    }

    if (request.name === "addNote") {
      const parsed = addNoteInput.safeParse(request.args);
      if (!parsed.success) {
        return context.json<NizhalPushResponse>(
          { status: "rejected", error: "invalid addNote arguments" },
          422,
        );
      }
      const args = parsed.data;
      const row = { id: args.clientId, owner_id: OWNER_ID, title: args.title, body: args.body };
      notes.set(row.id, row);
      sequence += 1;
      changes.push({ sequence, type: "upsert", row });
    } else if (request.name === "deleteNote") {
      const parsed = deleteNoteInput.safeParse(request.args);
      if (!parsed.success) {
        return context.json<NizhalPushResponse>(
          { status: "rejected", error: "invalid deleteNote arguments" },
          422,
        );
      }
      const args = parsed.data;
      notes.delete(args.noteId);
      sequence += 1;
      changes.push({ sequence, type: "delete", ownerId: OWNER_ID, id: args.noteId });
    } else {
      return context.json<NizhalPushResponse>(
        { status: "rejected", error: `unknown command '${request.name}'` },
        422,
      );
    }

    appliedMutations.add(request.clientMutationId);
    return context.json<NizhalPushResponse>({ status: "applied" });
  });

  app.post("/nizhal/pull", async (context) => {
    const request = await context.req.json<NizhalPullRequest>();
    const cursor = request.cursor === "" ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return context.json({ error: "invalid cursor" }, 400);
    }
    const allowed = new Set(request.buckets);
    const page = changes.filter(
      (change) =>
        change.sequence > cursor &&
        allowed.has(change.type === "upsert" ? change.row.owner_id : change.ownerId),
    );
    const changedRows = page
      .filter((change): change is Extract<Change, { type: "upsert" }> => change.type === "upsert")
      .map((change) => change.row);
    const response: NizhalPullResponse = {
      changed: changedRows.length > 0 ? [{ table: "notes", rows: changedRows }] : [],
      tombstoned: page
        .filter((change): change is Extract<Change, { type: "delete" }> => change.type === "delete")
        .map((change) => ({ table: "notes", id: change.id })),
      removedBuckets: [],
      cursor: String(sequence),
      hasMore: false,
    };
    return context.json(response);
  });

  return {
    app,
    hasNote: (id: string) => notes.has(id),
    noteCount: () => notes.size,
    duplicatePushCount: () => duplicatePushes,
  };
}

function backendTarget(baseUrl: string, available: () => boolean): NizhalSyncTarget {
  async function post<T>(path: string, body: unknown): Promise<T> {
    if (!available()) {
      throw new NizhalSyncTargetError("brownfield backend is offline", { retriable: true });
    }
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new NizhalSyncTargetError("brownfield backend transport failed", {
        retriable: true,
        cause,
      });
    }
    if (!response.ok) {
      throw new NizhalSyncTargetError(
        `brownfield backend rejected request: ${response.status} ${await response.text()}`,
        { retriable: response.status === 429 || response.status >= 500 },
      );
    }
    return (await response.json()) as T;
  }

  return {
    pull: (request) => post<NizhalPullResponse>("/nizhal/pull", request),
    push: (request) => post<NizhalPushResponse>("/nizhal/push", request),
  };
}

function createDevice(target: NizhalSyncTarget, id: string) {
  const client = createNizhalClient({
    syncTarget: target,
    deviceId: id,
    bucketsForSyncRule: () => [OWNER_ID],
  });
  const collection = createCollection(
    nizhalCollectionOptions<object>({
      name: "notes",
      syncRule: "myNotes",
      echo: client,
      getKey: noteId,
    }),
  );
  return { client, collection };
}

async function run(): Promise<void> {
  const backend = createBrownfieldBackend();
  const server = serve({ fetch: backend.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("backend did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let online = false;
  const targetA = backendTarget(baseUrl, () => online);
  const targetB = backendTarget(baseUrl, () => true);
  const deviceA = createDevice(targetA, "device-a");
  const deviceB = createDevice(targetB, "device-b");
  const mutators = createNizhalMutators({
    collections: { notes: deviceA.collection },
    echo: deviceA.client,
    actor: { userId: "user-1", ownerId: OWNER_ID },
    mutators: notesMutators,
    clientID: "device-a",
  });

  try {
    await Promise.all([deviceA.collection.preload(), deviceB.collection.preload()]);
    await mutators.executor.waitForInit();

    mutators.mutate.addNote({ clientId: "note-1", title: "Offline", body: "queued locally" });
    await waitFor(() => deviceA.collection.get("note-1") !== undefined);
    assert(!backend.hasNote("note-1"), "offline write must not reach the backend");

    online = true;
    await mutators.waitForIdle();
    assert(backend.hasNote("note-1"), "offline command must replay on reconnect");

    await deviceB.client.pull({ cursor: "", syncRule: "myNotes" });
    await waitFor(() => deviceB.collection.get("note-1") !== undefined);
    assert(
      noteBody(deviceB.collection.get("note-1")) === "queued locally",
      "device B must converge",
    );

    const firstPush = await targetA.push({
      name: "addNote",
      args: { clientId: "note-idempotent", title: "Once", body: "deduplicated" },
      clientMutationId: "fixed-mutation-id",
      clientID: "device-a",
      mutationID: 100,
      hlc: "1000-0-device-a",
    });
    const retryPush = await targetA.push({
      name: "addNote",
      args: { clientId: "note-idempotent", title: "Once", body: "deduplicated" },
      clientMutationId: "fixed-mutation-id",
      clientID: "device-a",
      mutationID: 100,
      hlc: "1000-0-device-a",
    });
    assert(firstPush.status === "applied" && retryPush.status === "duplicate", "retry must dedup");
    assert(
      backend.noteCount() === 2 && backend.duplicatePushCount() === 1,
      "retry must not duplicate data",
    );

    mutators.mutate.deleteNote({ noteId: "note-1" });
    await mutators.waitForIdle();
    await deviceB.client.pull({ cursor: deviceB.client.getCursor("myNotes"), syncRule: "myNotes" });
    await waitFor(() => deviceB.collection.get("note-1") === undefined);
    assert(!backend.hasNote("note-1"), "tombstone must delete the backend and device B row");

    console.log("BYO SYNC E2E PASSED ✅");
  } finally {
    await mutators.dispose();
    await Promise.all([deviceA.collection.cleanup(), deviceB.collection.cleanup()]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function noteId(row: object): string {
  if (!("id" in row) || typeof row.id !== "string")
    throw new Error("synced note is missing its id");
  return row.id;
}

function noteBody(row: object | undefined): unknown {
  return row && "body" in row ? row.body : undefined;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for BYO sync condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
