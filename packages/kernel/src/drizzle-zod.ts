import type { Table } from "drizzle-orm/table";
import { createSelectSchema as drizzleCreateSelectSchema } from "drizzle-zod";
import type { Schema } from "./types.js";

export function createSelectSchema(table: Table): Schema<unknown> {
  return drizzleCreateSelectSchema(table);
}
