import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type SyncedSchemaSnapshot,
  diffSyncedSchema,
  syncedSchemaSnapshot,
} from "../src/schema-evolution.js";
import { defineSyncRules } from "../src/sync-rules.js";

// P4 (T16): the additive-only schema-evolution guard. `diffSyncedSchema` is the pure core the
// `nizhal migrate` guard enforces — additive changes are safe for an un-updatable fleet, breaking
// ones are named.

const notes = pgTable("se_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body"),
});
const audit = pgTable("se_audit", { id: text("id").primaryKey(), at: timestamp("at") });
const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("se_notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

describe("syncedSchemaSnapshot", () => {
  it("captures the synced tables' columns and excludes non-synced tables", () => {
    const snap = syncedSchemaSnapshot({ notes, audit }, syncRules);
    expect(Object.keys(snap)).toEqual(["se_notes"]); // se_audit is not in a sync rule
    expect(snap.se_notes).toMatchObject({
      id: { type: "text", notNull: true, hasDefault: false },
      owner_id: { type: "text", notNull: true, hasDefault: false },
      body: { type: "text", notNull: false, hasDefault: false },
    });
  });
});

const base: SyncedSchemaSnapshot = {
  t: {
    id: { type: "text", notNull: true, hasDefault: false },
    body: { type: "text", notNull: false, hasDefault: false },
  },
};

describe("diffSyncedSchema — additive changes are safe", () => {
  it("no change → no breaks", () => {
    expect(diffSyncedSchema(base, base)).toEqual([]);
  });
  it("new nullable column → no breaks", () => {
    const next = { t: { ...base.t, note: { type: "text", notNull: false, hasDefault: false } } };
    expect(diffSyncedSchema(base, next)).toEqual([]);
  });
  it("new NOT NULL column WITH a default → no breaks", () => {
    const next = { t: { ...base.t, n: { type: "integer", notNull: true, hasDefault: true } } };
    expect(diffSyncedSchema(base, next)).toEqual([]);
  });
  it("a brand-new synced table → no breaks", () => {
    const next = { ...base, u: { id: { type: "text", notNull: true, hasDefault: false } } };
    expect(diffSyncedSchema(base, next)).toEqual([]);
  });
});

describe("diffSyncedSchema — breaking changes are named", () => {
  it("dropped column", () => {
    const next = { t: { id: base.t.id } };
    const breaks = diffSyncedSchema(base, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ table: "t", column: "body", kind: "dropped" });
  });
  it("retyped column", () => {
    const next = { t: { ...base.t, body: { type: "integer", notNull: false, hasDefault: false } } };
    expect(diffSyncedSchema(base, next)[0]).toMatchObject({ column: "body", kind: "retyped" });
  });
  it("new NOT NULL column WITHOUT a default", () => {
    const next = { t: { ...base.t, n: { type: "integer", notNull: true, hasDefault: false } } };
    expect(diffSyncedSchema(base, next)[0]).toMatchObject({
      column: "n",
      kind: "newColumnNotNullNoDefault",
    });
  });
  it("existing column made NOT NULL without a default", () => {
    const next = { t: { ...base.t, body: { type: "text", notNull: true, hasDefault: false } } };
    expect(diffSyncedSchema(base, next)[0]).toMatchObject({
      column: "body",
      kind: "nowNotNullNoDefault",
    });
  });
  it("every breaking shape carries an actionable message", () => {
    const next = {
      t: { id: base.t.id, body: { type: "integer", notNull: true, hasDefault: false } },
    };
    for (const change of diffSyncedSchema(base, next)) {
      expect(change.message).toMatch(/--allow-breaking|default/);
    }
  });
});
