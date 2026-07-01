import { PGlite } from "@electric-sql/pglite";
import {
  type ContractSchemaSource,
  crdtText,
  defineMutator,
  defineMutators,
  defineSyncRules,
  formatHlc,
} from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { postgresStorage } from "../src/adapters/storage.js";
import { type NizhalAuth, createNizhalServer } from "../src/index.js";

const openDbs: PGlite[] = [];

const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: crdtText("body").notNull(),
  title: text("title"),
  label: text("label"),
});

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

describe("CRDT field merge", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("merges concurrent CRDT text updates while scalar LWW columns stay commit-ordered", async () => {
    const { db, storage } = await createProvisionedStorage({
      schema: { documents },
      tableMerge: "lww",
    });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: { documents },
      mutators: defineMutators({
        editBody: defineMutator({ parse: parseBodyEdit }, async ({ tx }, args) => {
          await tx
            .update(documents, { id: args.id })
            .set({ body: Buffer.from(args.bodyUpdate, "base64") });
          return { affectedBuckets: ["owner-1"] };
        }),
        editTitle: defineMutator({ parse: parseScalarEdit }, async ({ tx }, args) => {
          await tx.update(documents, { id: args.id }).set({ title: args.value });
          return { affectedBuckets: ["owner-1"] };
        }),
      }),
      syncRules,
      auth,
      storage,
    });

    await db.query("insert into documents (id, owner_id, body) values ($1, $2, $3)", [
      "doc-1",
      "owner-1",
      emptyDocUpdate(),
    ]);

    const updateA = textUpdate("Alice");
    const updateB = textUpdate("Bob");

    await postJson(server.app, "/sync/push", {
      mutations: [
        {
          name: "editBody",
          args: { id: "doc-1", bodyUpdate: updateA },
          clientMutationId: "cmid-a",
        },
        {
          name: "editTitle",
          args: { id: "doc-1", value: "first" },
          clientMutationId: "cmid-title-1",
        },
        {
          name: "editBody",
          args: { id: "doc-1", bodyUpdate: updateB },
          clientMutationId: "cmid-b",
        },
        {
          name: "editTitle",
          args: { id: "doc-1", value: "second" },
          clientMutationId: "cmid-title-2",
        },
      ],
    });

    const row = await db.query<{ body: Uint8Array; title: string }>(
      "select body, title from documents where id = $1",
      ["doc-1"],
    );
    const bodyText = decodeText(row.rows[0]?.body);

    expect(bodyText).toContain("Alice");
    expect(bodyText).toContain("Bob");
    expect(row.rows[0]?.title).toBe("second");
  });

  it("merges concurrent CRDT text updates on a field-merge table while scalars resolve by HLC", async () => {
    const { db, storage } = await createProvisionedStorage({
      schema: { documents: { table: documents, merge: "field" } },
      tableMerge: "field",
    });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: { documents: { table: documents, merge: "field" } },
      mutators: defineMutators({
        editBody: defineMutator({ parse: parseBodyEdit }, async ({ tx }, args) => {
          await tx
            .update(documents, { id: args.id })
            .set({ body: Buffer.from(args.bodyUpdate, "base64") });
          return { affectedBuckets: ["owner-1"] };
        }),
        editTitle: defineMutator({ parse: parseScalarEdit }, async ({ tx }, args) => {
          await tx.update(documents, { id: args.id }).set({ title: args.value });
          return { affectedBuckets: ["owner-1"] };
        }),
        editLabel: defineMutator({ parse: parseScalarEdit }, async ({ tx }, args) => {
          await tx.update(documents, { id: args.id }).set({ label: args.value });
          return { affectedBuckets: ["owner-1"] };
        }),
      }),
      syncRules,
      auth,
      storage,
    });

    await db.query("insert into documents (id, owner_id, body) values ($1, $2, $3)", [
      "doc-1",
      "owner-1",
      emptyDocUpdate(),
    ]);

    const low = formatHlc({
      wallTime: Date.UTC(2026, 0, 1),
      counter: 0,
      nodeId: "0000000000000001",
    });
    const high = formatHlc({
      wallTime: Date.UTC(2026, 0, 2),
      counter: 0,
      nodeId: "0000000000000002",
    });

    const updateA = textUpdate("Alice");
    const updateB = textUpdate("Bob");

    await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "editBody",
          { id: "doc-1", bodyUpdate: updateA },
          "client-a",
          1,
          "cmid-a",
        ),
        sequencedMutation(
          "editTitle",
          { id: "doc-1", value: "Low" },
          "client-title",
          1,
          "cmid-t1",
          low,
        ),
        sequencedMutation(
          "editLabel",
          { id: "doc-1", value: "High" },
          "client-label",
          1,
          "cmid-l1",
          high,
        ),
      ],
    });
    await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "editBody",
          { id: "doc-1", bodyUpdate: updateB },
          "client-b",
          1,
          "cmid-b",
        ),
        sequencedMutation(
          "editTitle",
          { id: "doc-1", value: "High" },
          "client-title",
          2,
          "cmid-t2",
          high,
        ),
        sequencedMutation(
          "editTitle",
          { id: "doc-1", value: "Low2" },
          "client-title",
          3,
          "cmid-t3",
          low,
        ),
      ],
    });

    const row = await db.query<{
      body: Uint8Array;
      title: string;
      label: string;
      _meta: Record<string, string>;
    }>("select body, title, label, _meta from documents where id = $1", ["doc-1"]);
    const bodyText = decodeText(row.rows[0]?.body);

    expect(bodyText).toContain("Alice");
    expect(bodyText).toContain("Bob");
    expect(row.rows[0]?.title).toBe("High");
    expect(row.rows[0]?.label).toBe("High");
    expect(row.rows[0]?._meta.title).toBe(high);
    expect(row.rows[0]?._meta.label).toBe(high);
  });

  it("round-trips a CRDT column through pull as a base64-encoded update", async () => {
    const { db, storage } = await createProvisionedStorage({
      schema: { documents },
      tableMerge: "lww",
    });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: { documents },
      mutators: defineMutators({
        editBody: defineMutator({ parse: parseBodyEdit }, async ({ tx }, args) => {
          await tx
            .update(documents, { id: args.id })
            .set({ body: Buffer.from(args.bodyUpdate, "base64") });
          return { affectedBuckets: ["owner-1"] };
        }),
      }),
      syncRules,
      auth,
      storage,
    });

    await db.query("insert into documents (id, owner_id, body) values ($1, $2, $3)", [
      "doc-1",
      "owner-1",
      emptyDocUpdate(),
    ]);

    const updateA = textUpdate("Alice");
    await postJson(server.app, "/sync/push", {
      mutations: [
        {
          name: "editBody",
          args: { id: "doc-1", bodyUpdate: updateA },
          clientMutationId: "cmid-a",
        },
      ],
    });

    const pull = await postJson(server.app, "/sync/pull", { cursor: "" });
    const body = (await pull.json()) as {
      changed: { table: string; rows: { id: string; body: string }[] }[];
    };
    const row = body.changed.find((batch) => batch.table === "documents")?.rows[0];

    expect(row).toBeDefined();
    expect(typeof row?.body).toBe("string");
    expect(Buffer.from(row?.body ?? "", "base64").length).toBeGreaterThan(0);
    expect(decodeText(Buffer.from(row?.body ?? "", "base64"))).toContain("Alice");
  });
});

async function createProvisionedStorage(opts: {
  schema: Record<string, ContractSchemaSource>;
  tableMerge?: "lww" | "field";
}) {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({
    connectionString: "postgres://unused",
    client: db,
  });
  await db.exec(`
    create table documents (
      id text primary key,
      owner_id text not null,
      body bytea not null,
      title text,
      label text
    );
  `);
  await storage.provision({ schema: opts.schema, syncRules });
  return { db, storage };
}

function parseBodyEdit(input: unknown): { id: string; bodyUpdate: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { id?: unknown }).id === "string" &&
    typeof (input as { bodyUpdate?: unknown }).bodyUpdate === "string"
  ) {
    return input as { id: string; bodyUpdate: string };
  }
  throw new Error("invalid body edit input");
}

function parseScalarEdit(input: unknown): { id: string; value: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { id?: unknown }).id === "string" &&
    typeof (input as { value?: unknown }).value === "string"
  ) {
    return input as { id: string; value: string };
  }
  throw new Error("invalid scalar edit input");
}

function textUpdate(textValue: string): string {
  const doc = new Y.Doc();
  doc.getText("echo:text").insert(0, textValue);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function emptyDocUpdate(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

function decodeText(bytes: Uint8Array | Buffer | number[]): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(bytes));
  return doc.getText("echo:text").toString();
}

function sequencedMutation(
  name: string,
  args: unknown,
  clientID: string,
  mutationID: number,
  clientMutationId: string,
  hlc = formatHlc({ wallTime: Date.UTC(2026, 0, 1), counter: mutationID, nodeId: clientID }),
) {
  return { name, args, clientID, mutationID, clientMutationId, hlc };
}

async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
