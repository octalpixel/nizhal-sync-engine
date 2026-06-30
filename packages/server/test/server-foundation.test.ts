import { defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildListenNotifyProvisionPlan } from "../src/adapters/realtime.js";
import { type StorageAdapter, buildPostgresProvisionPlan } from "../src/adapters/storage.js";
import { bearerTokenAuth } from "../src/auth.js";
import { type NizhalAuth, createNizhalServer } from "../src/index.js";

const auth: NizhalAuth = {
  async resolve() {
    return { userId: "user-1", ownerId: "owner-1" };
  },
};

const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
});

describe("@nizhal/server foundation", () => {
  it("builds Postgres provisioning DDL without logical replication", () => {
    const syncRules = defineSyncRules((b) => ({
      myBucket: b.bucket({
        parameters: () => b.params({ shopId: "shop_id" }),
        data: (bucket) => [b.table("ledger_entries").where(b.eq("shop_id", bucket.shopId))],
      }),
    }));
    const ddl = buildPostgresProvisionPlan({ schema: {}, syncRules }).statements.join("\n");

    expect(ddl).toContain('alter table "ledger_entries" add column if not exists updated_at');
    expect(ddl).toContain('alter table "ledger_entries" add column if not exists deleted_at');
    expect(ddl).toContain('create trigger "_nizhal_touch_ledger_entries"');
    expect(ddl).toContain(
      'create index if not exists "_nizhal_ledger_entries_shop_id_row_version_idx"',
    );
    expect(ddl).toContain("create table if not exists _nizhal_mutations");
    expect(ddl).toContain("create table if not exists _nizhal_tombstones");
    expect(ddl).toContain("create table if not exists _nizhal_client_buckets");
    expect(ddl).toContain("create table if not exists _nizhal_jobs");
    expect(ddl).not.toContain("pg_notify");
    expect(ddl).not.toContain("wal_level");
    expect(ddl).not.toContain("replication slot");
  });

  it("keeps Postgres notify trigger DDL in the listen/notify realtime adapter", () => {
    const syncRules = defineSyncRules((b) => ({
      myBucket: b.bucket({
        parameters: () => b.params({ shopId: "shop_id" }),
        data: (bucket) => [b.table("ledger_entries").where(b.eq("shop_id", bucket.shopId))],
      }),
    }));
    const ddl = buildListenNotifyProvisionPlan({ schema: {}, syncRules }).statements.join("\n");

    expect(ddl).toContain("pg_notify('echo_bucket', bucket)");
    expect(ddl).toContain('create trigger "_nizhal_notify_ledger_entries_shop_id_trg"');
  });

  it("serves the emitted contract at /nizhal/contract", async () => {
    const syncRules = defineSyncRules((b) => ({
      myBucket: b.bucket({
        parameters: () => b.params({ shopId: "shop_id" }),
        data: (bucket) => [b.table("ledger_entries").where(b.eq("shop_id", bucket.shopId))],
      }),
    }));
    const storage = fakeStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {
        ledger_entries: ledgerEntries,
      },
      mutators: defineMutators({}),
      syncRules,
      auth,
      storage,
    });

    const response = await server.app.request("/nizhal/contract");
    const contract = await response.json();
    expect(response.status).toBe(200);
    expect(contract["x-echo"].collections).toEqual(["ledger_entries"]);
    expect(contract["x-echo"].syncRules).toEqual(["myBucket"]);
  });

  it("does not record a failed mutator as applied", async () => {
    const syncRules = defineSyncRules({ myBucket: { parameters: () => ({}), data: () => [] } });
    const storage = fakeStorage();
    const mutators = defineMutators({
      cascade: defineMutator({ parse: (input) => input }, async ({ tx }) => {
        (tx as { writes: string[] }).writes.push("parent");
        throw new Error("cascade failed");
      }),
    });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators,
      syncRules,
      auth,
      storage,
    });

    const response = await server.app.request("/sync/push", {
      method: "POST",
      body: JSON.stringify({
        mutations: [{ name: "cascade", args: {}, clientMutationId: "cmid-1" }],
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(500);
    expect(storage.applied).toEqual([]);
    expect(storage.writes).toEqual([]);
  });

  it("authenticates bearer tokens through the default verifier helper", async () => {
    const syncRules = defineSyncRules({ myBucket: { parameters: () => ({}), data: () => [] } });
    const storage = fakeStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules,
      auth: bearerTokenAuth({
        verify: (token) => (token === "good" ? { userId: "user-1", ownerId: "owner-1" } : null),
      }),
      storage,
    });

    const good = await server.app.request("/sync/pull", {
      method: "POST",
      headers: { authorization: "Bearer good" },
    });
    const bad = await server.app.request("/sync/pull", {
      method: "POST",
      headers: { authorization: "Bearer bad" },
    });

    expect(good.status).toBe(200);
    expect(bad.status).toBe(401);
  });
});

function fakeStorage(): StorageAdapter & { applied: string[]; writes: string[] } {
  const storage = {
    applied: [] as string[],
    writes: [] as string[],
    async getChanges() {
      return { changed: [], tombstoned: [], cursor: "" };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      const tx = { applied: new Set(storage.applied), writes: [...storage.writes] };
      const result = await fn(tx);
      storage.applied = Array.from(tx.applied);
      storage.writes = tx.writes;
      return result;
    },
    async authorizeMutatorTx(input: Parameters<StorageAdapter["authorizeMutatorTx"]>[0]) {
      return input.mutatorTx;
    },
    async claimMutation(tx: unknown, clientMutationId: string) {
      const applied = (tx as { applied: Set<string> }).applied;
      if (applied.has(clientMutationId)) return false;
      applied.add(clientMutationId);
      return true;
    },
    async isApplied(clientMutationId: string) {
      return storage.applied.includes(clientMutationId);
    },
    async readLastMutationId() {
      return 0;
    },
    async recordApplied(clientMutationId: string, _map?: unknown, tx?: unknown) {
      const applied =
        tx === undefined ? new Set(storage.applied) : (tx as { applied: Set<string> }).applied;
      applied.add(clientMutationId);
      if (tx === undefined) storage.applied = Array.from(applied);
    },
    async provision() {},
  };
  return storage;
}
