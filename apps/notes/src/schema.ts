import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};

export const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});

export const notesSchema = {
  notes,
} as const;

export type NoteRow = typeof notes.$inferSelect;

export const NOTES_DDL = `
  create table notes (
    id text primary key,
    owner_id text not null,
    title text not null,
    body text not null,
    created_at timestamptz not null default now()
  );
`;
