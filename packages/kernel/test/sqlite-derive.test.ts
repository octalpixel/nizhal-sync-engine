import { getTableColumns, getTableName } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { text as sqliteText } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { deriveSqliteSchema, tablePrimaryKeyColumn } from "../src/sqlite-derive.js";

const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["credit", "payment"] }).notNull(),
  active: boolean("active").notNull(),
  meta: jsonb("meta"),
  count: integer("count"),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

describe("deriveSqliteSchema", () => {
  it("derives sqlite tables preserving names, pk, notNull", () => {
    const derived = deriveSqliteSchema({ customers, notATable: 42 });
    expect(Object.keys(derived)).toEqual(["customers"]);
    const table = derived.customers;
    expect(getTableName(table)).toBe("customers");
    const columns = getTableColumns(table) as Record<
      string,
      { columnType: string; primary: boolean; notNull: boolean }
    >;
    expect(columns.id?.primary).toBe(true);
    expect(columns.name?.notNull).toBe(true);
    expect(columns.active?.columnType).toBe("SQLiteBoolean");
    expect(columns.updated_at?.columnType).toBe("SQLiteTimestamp");
    // server-defaulted columns lose NOT NULL on the client (mutators legitimately omit them)
    expect(columns.updated_at?.notNull).toBe(false);
    expect(columns.meta?.columnType).toBe("SQLiteTextJson");
    expect(columns.count?.columnType).toBe("SQLiteInteger");
    expect(columns.count?.notNull).toBe(false);
  });

  it("fails closed on unsupported column types, naming the override key", () => {
    const bad = pgTable("weird", {
      id: text("id").primaryKey(),
      blob: (jsonb as unknown as typeof jsonb)("payload"),
    });
    // simulate an unknown type by lying about columnType
    const columns = getTableColumns(bad) as Record<string, { columnType: string }>;
    const payload = columns.blob;
    if (payload) payload.columnType = "PgVector";
    expect(() => deriveSqliteSchema({ bad })).toThrow(/weird\.payload/);
  });

  it("honors per-column overrides", () => {
    const bad = pgTable("weird2", {
      id: text("id").primaryKey(),
      vec: text("vec"),
    });
    const columns = getTableColumns(bad) as Record<string, { columnType: string }>;
    const vec = columns.vec;
    if (vec) vec.columnType = "PgVector";
    const derived = deriveSqliteSchema({ bad }, { overrides: { "weird2.vec": sqliteText("vec") } });
    const derivedColumns = getTableColumns(derived.bad) as Record<string, { columnType: string }>;
    expect(derivedColumns.vec?.columnType).toBe("SQLiteText");
  });

  it("tablePrimaryKeyColumn finds the single pk and rejects pk-less tables", () => {
    expect(tablePrimaryKeyColumn(customers)).toEqual({ key: "id", name: "id" });
    const nopk = pgTable("nopk", { a: text("a") });
    expect(() => tablePrimaryKeyColumn(nopk)).toThrow(/exactly one primary-key/);
  });
});
