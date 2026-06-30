import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";
import { type NizhalAuth, createNizhalServer } from "../src/index.js";

const openDbs: PGlite[] = [];

const items = pgTable("items", {
  id: text("id").primaryKey(),
  room_id: text("room_id").notNull(),
  num: integer("num").notNull(),
});

const rules = defineSyncRules((b) => ({
  room: b.bucket({
    parameters: () => b.params({ roomId: "room_id" }),
    data: (bucket) => [b.table("items").where(b.eq("room_id", bucket.roomId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve() {
    return { userId: "u", ownerId: "org", roomId: "room-a" };
  },
};

const mutators = defineMutators({
  addItem: defineMutator(
    { parse: (input: unknown) => input as { id: string; roomId: string } },
    async (ctx, args) => {
      if (!ctx.nextInBucket) throw new Error("nextInBucket unavailable");
      const num = await ctx.nextInBucket({
        table: "items",
        sequenceColumn: "num",
        scopeColumn: "room_id",
        scopeValue: args.roomId,
      });
      await ctx.tx.insert(items).values({ id: args.id, room_id: args.roomId, num });
      return { serverId: args.id, affectedBuckets: [args.roomId] };
    },
  ),
});

async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("ctx.nextInBucket — server-authoritative per-bucket sequence", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("assigns distinct per-bucket numbers to two writes that both guessed the same (number-collision)", async () => {
    const db = new PGlite();
    openDbs.push(db);
    const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
    await db.exec(
      "create table items (id text primary key, room_id text not null, num integer not null)",
    );
    await storage.provision({ schema: { items }, syncRules: rules });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: { items },
      mutators,
      syncRules: rules,
      auth,
      storage,
    });

    // Two offline clients each created an item in room-a; each would have guessed num=1 locally.
    const r1 = await postJson(server.app, "/sync/push", {
      mutations: [
        { name: "addItem", args: { id: "i1", roomId: "room-a" }, clientMutationId: "c1" },
      ],
    });
    const r2 = await postJson(server.app, "/sync/push", {
      mutations: [
        { name: "addItem", args: { id: "i2", roomId: "room-a" }, clientMutationId: "c2" },
      ],
    });

    expect(r1.status, await r1.clone().text()).toBe(200);
    expect(r2.status, await r2.clone().text()).toBe(200);

    const rows = await db.query<{ id: string; num: number }>(
      "select id, num from items order by num",
    );
    // Server assigns authoritatively → distinct, monotonic numbers, no collision.
    expect(rows.rows.map((row) => row.num)).toEqual([1, 2]);
  });
});
