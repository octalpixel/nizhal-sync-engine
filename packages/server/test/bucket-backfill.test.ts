import { PGlite } from "@electric-sql/pglite";
import { defineSyncRules } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";

const openDbs: PGlite[] = [];

const items = pgTable("items", {
  id: text("id").primaryKey(),
  room_id: text("room_id").notNull(),
});

const rules = defineSyncRules((b) => ({
  room: b.bucket({
    parameters: (actor) =>
      b.membership({
        table: "room_members",
        where: { user_id: actor.userId },
        select: { roomId: "room_id" },
      }),
    data: (bucket) => [b.table("items").where(b.eq("room_id", bucket.roomId))],
  }),
}));

function rowIds(result: { changed: { rows: { id: string }[] }[] }): string[] {
  return result.changed.flatMap((c) => c.rows.map((r) => r.id)).sort();
}

describe("bucket join backfill (G1)", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("backfills a newly-joined bucket's pre-existing history (G1)", async () => {
    const db = new PGlite();
    openDbs.push(db);
    const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
    await db.exec(`
      create table room_members (user_id text not null, room_id text not null, primary key (user_id, room_id));
      create table items (id text primary key, room_id text not null);
    `);
    await storage.provision({ schema: { items }, syncRules: rules });

    // room-b's history is written FIRST (low row-versions); room-a's item LATER (higher version).
    await db.exec(
      "insert into items (id, room_id) values ('b1','room-b'),('b2','room-b'),('a1','room-a')",
    );
    await db.exec("insert into room_members (user_id, room_id) values ('u','room-a')");

    const actor = { userId: "u", ownerId: "org" };
    // First pull: member of room-a only → gets a1; cursor advances PAST b1,b2 (unseen, lower version).
    const first = await storage.getChanges({
      actor,
      syncRules: rules,
      cursor: "",
      deviceId: "dev",
    });
    expect(rowIds(first)).toEqual(["a1"]);

    // u JOINS room-b (membership granted server-side).
    await db.exec("insert into room_members (user_id, room_id) values ('u','room-b')");

    // Second pull from the advanced cursor. b1,b2 have version < cursor → the bug skips them.
    const second = await storage.getChanges({
      actor,
      syncRules: rules,
      cursor: first.cursor,
      deviceId: "dev",
    });

    // G1: gaining access to room-b must backfill its pre-existing history.
    expect(second.cursorReset).toBe(true);
    expect(rowIds(second)).toEqual(["a1", "b1", "b2"]);
  });
});
