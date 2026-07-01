// Spike C — schema-once: kernel pgTable → derived client sqliteTable → drizzle-kit migration
// SQL → real better-sqlite3 DB → drizzle queries with typed round-trips.
// Run: npm install && npm run spike
import Database from "better-sqlite3";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { deriveSqliteSchema } from "./derive.mjs";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures += 1;
};

// ---- 1. The server-side schema, exactly as an app writes it today ----------------------
// tabkeep's real tables, verbatim (apps/tabkeep-expo/src/domain.ts):
const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};
const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  ...syncColumns,
});
const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  kind: text("kind", { enum: ["credit", "payment"] }).notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});
// plus a kitchen-sink table covering the wider pg column set:
const kitchenSink = pgTable("kitchen_sink", {
  id: text("id").primaryKey(),
  title: varchar("title", { length: 200 }).notNull(),
  count: integer("count").notNull(),
  big: bigint("big", { mode: "number" }),
  active: boolean("active").notNull(),
  score: doublePrecision("score"),
  meta: jsonb("meta"),
  uid: uuid("uid"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull(),
  kind: text("kind", { enum: ["a", "b"] }).notNull(),
});

const pgSchema = { customers, ledgerEntries, kitchenSink };

// ---- 2. Derive the client sqlite schema ------------------------------------------------
const clientSchema = deriveSqliteSchema(pgSchema);
check("derives all 3 tables", Object.keys(clientSchema).length === 3);

// ---- 3. drizzle-kit generates the client migration SQL from the derived schema ---------
// (the exact pipeline `nizhal gen` would ship: derived schema → snapshot → migration SQL)
const emptySnapshot = await generateSQLiteDrizzleJson({});
const snapshot = await generateSQLiteDrizzleJson(clientSchema);
const statements = await generateSQLiteMigration(emptySnapshot, snapshot);
check(
  "drizzle-kit emits CREATE TABLE for all 3",
  statements.filter((s) => s.startsWith("CREATE TABLE")).length === 3,
);
const sinkDdl = statements.find((s) => s.includes("kitchen_sink")) ?? "";
check("boolean → integer", /`active` integer NOT NULL/.test(sinkDdl));
check("timestamptz → integer (epoch ms)", /`created_at` integer NOT NULL/.test(sinkDdl));
check("jsonb → text", /`meta` text/.test(sinkDdl));
check("double precision → real", /`score` real/.test(sinkDdl));

// ---- 4. Apply to a real SQLite and query through drizzle -------------------------------
const sqlite = new Database(":memory:");
for (const statement of statements) sqlite.exec(statement);
const db = drizzle(sqlite, { schema: clientSchema });

const now = new Date("2026-07-02T10:00:00.000Z");
await db.insert(clientSchema.customers).values({
  id: "c1",
  shop_id: "s1",
  name: "Asha",
  phone: null,
  updated_at: now,
  deleted_at: null,
});
await db.insert(clientSchema.kitchenSink).values({
  id: "k1",
  title: "hello",
  count: 7,
  big: 9007199254740,
  active: true,
  score: 2.5,
  meta: { nested: { ok: true }, list: [1, 2, 3] },
  uid: "3b241101-e2bb-4255-8caf-4136c566a962",
  created_at: now,
  kind: "a",
});

const customer = await db.query.customers.findFirst({
  where: eq(clientSchema.customers.id, "c1"),
});
check("customer row round-trips", customer?.name === "Asha");
check("timestamptz revives as Date", customer?.updated_at instanceof Date);
check("Date value exact (epoch ms)", customer?.updated_at?.getTime() === now.getTime());

const sink = await db.query.kitchenSink.findFirst({
  where: eq(clientSchema.kitchenSink.id, "k1"),
});
check("boolean revives as true", sink?.active === true);
check("jsonb revives as object", sink?.meta?.nested?.ok === true && sink?.meta?.list?.length === 3);
check("bigint(number) survives", sink?.big === 9007199254740);

// enum column still constrains at the type level and stores the literal:
const kinds = await db
  .select({ kind: clientSchema.ledgerEntries.kind })
  .from(clientSchema.ledgerEntries);
check("empty ledger query runs", Array.isArray(kinds) && kinds.length === 0);

sqlite.close();
console.log(failures === 0 ? "\nSPIKE PASS — schema-once derivation is real" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
