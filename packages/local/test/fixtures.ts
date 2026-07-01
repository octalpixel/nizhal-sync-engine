import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BundledMigrations } from "../src/index.js";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done").notNull().default(0),
  priority: integer("priority").default(0),
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
});

export const schema = { tasks, notes };

/** Hand-rolled equivalent of drizzle-kit's generated `./drizzle/migrations.js` bundle. */
export const migrationsV1: BundledMigrations = {
  journal: {
    entries: [{ idx: 0, when: 100, tag: "0000_init", breakpoints: true }],
  },
  migrations: {
    m0000:
      "CREATE TABLE `tasks` (`id` text PRIMARY KEY NOT NULL, `title` text NOT NULL, `done` integer DEFAULT 0 NOT NULL);",
  },
};

export const migrationsV2: BundledMigrations = {
  journal: {
    entries: [
      { idx: 0, when: 100, tag: "0000_init", breakpoints: true },
      { idx: 1, when: 200, tag: "0001_priority_notes", breakpoints: true },
    ],
  },
  migrations: {
    ...migrationsV1.migrations,
    m0001:
      "ALTER TABLE `tasks` ADD `priority` integer DEFAULT 0;--> statement-breakpoint\nCREATE TABLE `notes` (`id` text PRIMARY KEY NOT NULL, `body` text NOT NULL);",
  },
};
