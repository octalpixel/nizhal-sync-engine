import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});
