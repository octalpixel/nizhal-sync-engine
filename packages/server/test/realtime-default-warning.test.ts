import { PGlite } from "@electric-sql/pglite";
import { type SyncRules, defineSyncRules } from "@nizhal/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";
import { type NizhalAuth, createNizhalServer, inProcessRealtime } from "../src/index.js";

// inProcessRealtime is a dev/test default only (in-memory per-process — does not cross instances).
// createNizhalServer must warn if it's left defaulted in production so nobody ships the antipattern.

const syncRules: SyncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve() {
    return { userId: "u", ownerId: "o" };
  },
};

const openDbs: PGlite[] = [];
const originalEnv = process.env.NODE_ENV;
afterEach(async () => {
  process.env.NODE_ENV = originalEnv;
  vi.restoreAllMocks();
  await Promise.all(openDbs.splice(0).map((db) => db.close()));
});

function build(opts: { realtime?: ReturnType<typeof inProcessRealtime> } = {}) {
  const pg = new PGlite();
  openDbs.push(pg);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: pg });
  return createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: {},
    syncRules,
    auth,
    storage,
    ...(opts.realtime ? { realtime: opts.realtime } : {}),
  });
}

describe("realtime default warning", () => {
  it("warns when inProcessRealtime is left defaulted in production", () => {
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    build();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/inProcessRealtime.*does NOT cross instances/s);
  });

  it("does NOT warn when a realtime adapter is explicitly provided in production", () => {
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    build({ realtime: inProcessRealtime() });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn outside production even when defaulted", () => {
    process.env.NODE_ENV = "test";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    build();
    expect(warn).not.toHaveBeenCalled();
  });
});
