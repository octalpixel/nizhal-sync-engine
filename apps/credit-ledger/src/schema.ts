import { numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};

export const shops = pgTable("shops", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  owner_id: text("owner_id").notNull(),
  currency: text("currency").notNull().default("LKR"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shopMembers = pgTable("shop_members", {
  shop_id: text("shop_id").notNull(),
  user_id: text("user_id").notNull(),
  role: text("role").notNull(),
});

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  note: text("note"),
  client_id: text("client_id"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  amount: numeric("amount").notNull(),
  reason: text("reason"),
  ref: text("ref"),
  at: timestamp("at", { withTimezone: true }).notNull(),
  created_by: text("created_by").notNull(),
  client_id: text("client_id"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const reminders = pgTable("reminders", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  entry_id: text("entry_id").notNull(),
  scheduled_at: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  channel: text("channel").notNull().default("sms"),
  status: text("status").notNull().default("pending"),
  sent_at: timestamp("sent_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const creditLedgerSchema = {
  shops,
  shop_members: shopMembers,
  customers: { table: customers, merge: "field" as const },
  ledger_entries: ledgerEntries,
  reminders,
} as const;

export type CustomerRow = typeof customers.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;

export const CREDIT_LEDGER_DDL = `
  create table shops (
    id text primary key,
    name text not null,
    owner_id text not null,
    currency text not null default 'LKR',
    created_at timestamptz not null default now()
  );

  create table shop_members (
    shop_id text not null references shops(id),
    user_id text not null,
    role text not null,
    primary key (shop_id, user_id)
  );

  create table customers (
    id text primary key,
    shop_id text not null,
    name text not null,
    phone text,
    note text,
    client_id text unique,
    created_at timestamptz not null default now()
  );

  create table ledger_entries (
    id text primary key,
    shop_id text not null,
    customer_id text not null,
    amount numeric not null,
    reason text,
    ref text,
    at timestamptz not null,
    created_by text not null,
    client_id text unique,
    created_at timestamptz not null default now()
  );

  create table reminders (
    id text primary key,
    shop_id text not null,
    customer_id text not null,
    entry_id text not null,
    scheduled_at timestamptz not null,
    channel text not null default 'sms',
    status text not null default 'pending',
    sent_at timestamptz,
    created_at timestamptz not null default now()
  );
`;
