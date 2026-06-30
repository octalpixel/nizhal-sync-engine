import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { type LibsqlAuditStorage, libsqlAuditStorage } from "../src/adapters/libsql-audit.js";

const stores: LibsqlAuditStorage[] = [];
const clients: ReturnType<typeof createClient>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const client of clients.splice(0)) client.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RFC-008 libSQL audit storage", () => {
  it("provisions nothing when audit is off and provisions idempotently when enabled", async () => {
    const client = await testClient();
    const store = libsqlAuditStorage({ url: "file:unused.db", client });
    stores.push(store);

    await store.provision({ audit: false });
    expect(await tableNames(client)).toEqual([]);

    await store.provision({ audit: true });
    await store.provision({ audit: true });
    expect(await tableNames(client)).toEqual(["_nizhal_audit_log", "_nizhal_row_versions"]);
  });

  it("rolls back the business write and audit append in the same transaction", async () => {
    const { client, store } = await setup();
    await client.execute("create table business_rows (id text primary key)");

    await expect(
      store.transaction(async (tx) => {
        await tx.execute({ sql: "insert into business_rows (id) values (?)", args: ["row-1"] });
        await store.appendAudit(tx, entry("cmid-1", "user-1", "bucket-1"));
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");

    expect((await client.execute("select id from business_rows")).rows).toEqual([]);
    expect(await store.getAuditLog({ limit: 10 })).toEqual([]);
  });

  it("appends in shared row-version order and filters actor, bucket, and range", async () => {
    const { store } = await setup();
    await append(store, entry("cmid-1", "user-1", "bucket-1"));
    await append(store, entry("cmid-2", "user-2", "bucket-2"));
    await append(store, entry("cmid-3", "user-1", "bucket-1"));
    const all = await store.getAuditLog({ limit: 10 });

    expect(all.map((item) => item.clientMutationId)).toEqual(["cmid-1", "cmid-2", "cmid-3"]);
    expect(all.map((item) => BigInt(item.rowVersion))).toEqual([1n, 2n, 3n]);
    expect(
      (await store.getAuditLog({ actor: { userId: "user-2" }, limit: 10 })).map(
        (item) => item.clientMutationId,
      ),
    ).toEqual(["cmid-2"]);
    expect(
      (await store.getAuditLog({ buckets: ["bucket-1"], limit: 10 })).map(
        (item) => item.clientMutationId,
      ),
    ).toEqual(["cmid-1", "cmid-3"]);
    expect(
      (
        await store.getAuditLog({
          sinceVersion: all[0]?.rowVersion,
          untilVersion: all[1]?.rowVersion,
          limit: 10,
        })
      ).map((item) => item.clientMutationId),
    ).toEqual(["cmid-2"]);
  });
});

async function setup() {
  const client = await testClient();
  const store = libsqlAuditStorage({ url: "file:unused.db", client });
  stores.push(store);
  await store.provision({ audit: true });
  return { client, store };
}

async function append(store: LibsqlAuditStorage, value: ReturnType<typeof entry>): Promise<void> {
  await store.transaction((tx) => store.appendAudit(tx, value));
}

function entry(clientMutationId: string, userId: string, bucket: string) {
  return {
    clientMutationId,
    mutationName: "addNote",
    args: { body: clientMutationId },
    actor: { userId, ownerId: bucket },
    clientId: `client-${userId}`,
    mutationId: Number(clientMutationId.slice("cmid-".length)),
    hlc: `hlc-${clientMutationId}`,
    affectedBuckets: [bucket],
  };
}

async function tableNames(client: ReturnType<typeof createClient>): Promise<string[]> {
  const result = await client.execute(
    "select name from sqlite_master where type = 'table' and name like '_nizhal_%' order by name",
  );
  return result.rows.map((row) => String(row.name));
}

async function testClient(): Promise<ReturnType<typeof createClient>> {
  const dir = await mkdtemp(join(tmpdir(), "nizhal-libsql-audit-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "audit.db")}`, intMode: "bigint" });
  clients.push(client);
  return client;
}
