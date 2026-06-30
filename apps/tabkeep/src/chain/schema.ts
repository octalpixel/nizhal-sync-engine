import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};

// Synced, MUTABLE catalog. `merge: "field"` (declared in chainSchema) means concurrent edits to
// DIFFERENT attributes of the same product both survive (per-field LWW by HLC) — table-level LWW
// would lose one. Two staff of one branch editing price + stock at once is the realistic case.
export const products = pgTable("products", {
  id: text("id").primaryKey(),
  branch_id: text("branch_id").notNull(),
  name: text("name").notNull(),
  price: integer("price").notNull(), // minor units
  stock: integer("stock").notNull(),
  ...syncColumns,
});

// Synced, append-only sales (per branch) — the rollup source for HQ.
export const sales = pgTable("sales", {
  id: text("id").primaryKey(),
  branch_id: text("branch_id").notNull(),
  product_id: text("product_id").notNull(),
  qty: integer("qty").notNull(),
  amount: integer("amount").notNull(), // minor units, line total
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

// Receipt attachments. The ROW (metadata) syncs like any bucket-scoped row; the bytes live in the
// blob store, fetched via presigned URL. `id` is the content-hash blob key. branch_id is the bucket,
// so download authz (findBlobRef) only lets a member of that branch fetch the receipt.
export const receipts = pgTable("receipts", {
  id: text("id").primaryKey(),
  branch_id: text("branch_id").notNull(),
  sale_id: text("sale_id").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  status: text("status").notNull(), // 'pending' | 'synced'
  ...syncColumns,
});

// products → per-field merge; sales + receipts → table-level (append-only, never edited).
export const chainSchema = {
  products: { table: products, merge: "field" },
  sales,
  receipts,
} as const;

export type ProductRow = typeof products.$inferSelect;
export type SaleRow = typeof sales.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;

// Reference + authz tables — NOT synced (server-side only, seeded). `branch_members` drives the
// sync-rule membership: a user's buckets = the branch_ids they belong to (cashier → 1, owner → all).
// provision() augments the SYNCED tables (products, sales) with sync columns + field-merge infra;
// these plain tables it leaves alone.
export const CHAIN_DDL = `
  create table branches (
    id text primary key,
    chain_id text not null,
    name text not null
  );
  create table branch_members (
    user_id text not null,
    branch_id text not null,
    role text not null check (role in ('owner', 'manager', 'cashier')),
    primary key (user_id, branch_id)
  );
  create table products (
    id text primary key,
    branch_id text not null,
    name text not null,
    price integer not null check (price >= 0),
    stock integer not null default 0
  );
  create table sales (
    id text primary key,
    branch_id text not null,
    product_id text not null references products(id),
    qty integer not null check (qty > 0),
    amount integer not null check (amount >= 0),
    created_at timestamptz not null default now()
  );
  create table receipts (
    id text primary key,
    branch_id text not null,
    sale_id text not null,
    mime text not null,
    size integer not null check (size >= 0),
    status text not null check (status in ('pending', 'synced'))
  );
`;

export type ChainRole = "owner" | "manager" | "cashier";
