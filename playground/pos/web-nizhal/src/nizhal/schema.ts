import { integer, pgTable, real, text } from "drizzle-orm/pg-core";

// Same POS domain as the plain app, described for Nizhal mutators. owner_id is the sync bucket.
export const products = pgTable("products", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  name: text("name").notNull(),
  price: real("price").notNull(),
  stock: integer("stock").notNull().default(0),
});

export const sales = pgTable("sales", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  total: real("total").notNull(),
  created_at: text("created_at").notNull(),
});

export const saleItems = pgTable("sale_items", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  sale_id: text("sale_id").notNull(),
  product_id: text("product_id").notNull(),
  qty: integer("qty").notNull(),
  unit_price: real("unit_price").notNull(),
});

export interface ProductRow {
  id: string;
  owner_id: string;
  name: string;
  price: number;
  stock: number;
}
export interface SaleRow {
  id: string;
  owner_id: string;
  total: number;
  created_at: string;
}
export interface SaleItemRow {
  id: string;
  owner_id: string;
  sale_id: string;
  product_id: string;
  qty: number;
  unit_price: number;
}
