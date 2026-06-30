import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  ...syncColumns,
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  kind: text("kind", { enum: ["credit", "payment"] }).notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const tabkeepSchema = {
  customers,
  ledger_entries: ledgerEntries,
} as const;

export type CustomerRow = typeof customers.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;

export const TABKEEP_DDL = `
  create table customers (
    id text primary key,
    shop_id text not null,
    name text not null,
    phone text
  );

  create table ledger_entries (
    id text primary key,
    shop_id text not null,
    customer_id text not null references customers(id),
    kind text not null check (kind in ('credit', 'payment')),
    amount integer not null check (amount > 0),
    note text,
    created_at timestamptz not null default now()
  );
`;
