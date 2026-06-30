import { numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};

export const locations = pgTable("locations", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  name: text("name").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assets = pgTable("assets", {
  id: text("id").primaryKey(),
  location_id: text("location_id").notNull(),
  name: text("name").notNull(),
  sku: text("sku"),
  barcode: text("barcode"),
  price: numeric("price").notNull().default("0"),
  client_id: text("client_id"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const stockMovements = pgTable("stock_movements", {
  id: text("id").primaryKey(),
  location_id: text("location_id").notNull(),
  asset_id: text("asset_id").notNull(),
  qty: numeric("qty").notNull(),
  reason: text("reason").notNull(),
  ref: text("ref"),
  at: timestamp("at", { withTimezone: true }).notNull(),
  client_id: text("client_id"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const stockVariances = pgTable("stock_variances", {
  id: text("id").primaryKey(),
  location_id: text("location_id").notNull(),
  asset_id: text("asset_id").notNull(),
  qty_deficit: numeric("qty_deficit").notNull(),
  sale_ref: text("sale_ref").notNull(),
  flagged_at: timestamp("flagged_at", { withTimezone: true }).notNull(),
  client_id: text("client_id"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const posSchema = {
  locations,
  assets: { table: assets, merge: "field" as const },
  stock_movements: stockMovements,
  stock_variances: stockVariances,
} as const;

export type AssetRow = typeof assets.$inferSelect;
export type StockMovementRow = typeof stockMovements.$inferSelect;
export type StockVarianceRow = typeof stockVariances.$inferSelect;

export const POS_DDL = `
  create table locations (
    id text primary key,
    owner_id text not null,
    name text not null,
    created_at timestamptz not null default now()
  );

  create table assets (
    id text primary key,
    location_id text not null,
    name text not null,
    sku text,
    barcode text,
    price numeric not null default 0,
    client_id text unique,
    created_at timestamptz not null default now()
  );

  create table stock_movements (
    id text primary key,
    location_id text not null,
    asset_id text not null,
    qty numeric not null,
    reason text not null,
    ref text,
    at timestamptz not null,
    client_id text unique,
    created_at timestamptz not null default now()
  );

  create table stock_variances (
    id text primary key,
    location_id text not null,
    asset_id text not null,
    qty_deficit numeric not null,
    sale_ref text not null,
    flagged_at timestamptz not null,
    client_id text unique,
    created_at timestamptz not null default now()
  );
`;

export function foldStock(
  movements: readonly Pick<StockMovementRow, "asset_id" | "qty" | "deleted_at">[],
  assetId: string,
): number {
  return movements
    .filter((row) => row.asset_id === assetId && row.deleted_at == null)
    .reduce((sum, row) => sum + Number(row.qty), 0);
}
