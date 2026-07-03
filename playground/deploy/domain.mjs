// Shared reference domain + server config for the deploy examples (Node container + Bun + Vercel).
// One tiny "messages" table synced per room, with real bearer-token auth.
import { defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import { bearerTokenAuth, listenNotifyRealtime, postgresStorage } from "@nizhal/server";
import { pgTable, text } from "drizzle-orm/pg-core";

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  room_id: text("room_id").notNull(),
  body: text("body").notNull(),
});
export const schema = { messages };

export const syncRules = defineSyncRules((b) => ({
  room: b.bucket({
    parameters: () => b.params({ ownerId: "room_id" }),
    data: (bucket) => [b.table("messages").where(b.eq("room_id", bucket.ownerId))],
  }),
}));

const id = z.string().min(1);
export const mutators = defineMutators({
  postMessage: defineMutator(
    z.object({ id, body: z.string().min(1) }),
    async ({ tx, actor }, args) => {
      await tx.insert(messages).values({ id: args.id, room_id: actor.ownerId, body: args.body });
      return { serverId: args.id, affectedBuckets: [actor.ownerId] };
    },
  ),
});

/** Build the server config from the environment — identical across every host (container/Bun/Vercel). */
export function serverConfig(env = process.env) {
  const db = env.DATABASE_URL;
  if (!db) throw new Error("DATABASE_URL is required");
  return {
    db,
    schema: {},
    mutators,
    syncRules,
    // Real auth: a bearer JWT carrying { userId, ownerId }. On the WS upgrade the token also rides
    // the ?token= query (browsers/Node can't set upgrade headers), which the server reads.
    auth: bearerTokenAuth({ secret: env.JWT_SECRET ?? "dev-secret" }),
    storage: postgresStorage({ connectionString: db }),
    // Production multi-instance realtime — a DIRECT (session-mode) Postgres connection so LISTEN works.
    realtime: listenNotifyRealtime({ connectionString: db }),
  };
}

/** One-time setup an operator runs once (or the container entry runs on boot): the business table. */
export async function ensureTable(storage) {
  const { toNizhalDb } = await import("@nizhal/server");
  const { sql } = await import("drizzle-orm");
  const db = toNizhalDb(storage.getClient()).db;
  await db.execute(
    sql.raw(
      "create table if not exists messages (id text primary key, room_id text not null, body text not null)",
    ),
  );
}
