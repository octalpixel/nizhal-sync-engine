// Chat — Nizhal domain. Built on one first principle borrowed from Durable Objects:
//
//   A CHANNEL is a Durable Object.
//
// In DO terms `idFromName("channel-123")` gives one globally-unique, single-threaded instance that
// owns the room's ordered message log + the live WebSocket connections. Nizhal's equivalent of that
// instance is a SYNC BUCKET: `channel:<id>`. The bucket is the consistency boundary (serial total
// order of messages), the realtime fan-out boundary (who gets poked), and the authorization boundary
// (who may read). Each client holds a local SQLite *replica* of the channels it is a member of; sync
// reconciles the replica with the channel-bucket. The CF realtime adapter already runs one DO per
// bucket — so "channel = DO" is literal on the edge target, and a logical bucket everywhere else.
import {
  type SyncRuleBuilder,
  type SyncRules,
  defineMutator,
  defineMutators,
  defineSyncRules,
  z,
} from "@nizhal/kernel";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};

// `channel_id` is the bucket key on every row → it is the "idFromName" of the room. Membership rows
// are what authorize a device to subscribe to a channel bucket (the DO's access list).
export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  name: text("name").notNull(),
  topic: text("topic"),
  created_by: text("created_by").notNull(),
  ...syncColumns,
});
export const channelMembers = pgTable("channel_members", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(), // workspace bucket (so the member list syncs + creation is allowed)
  channel_id: text("channel_id").notNull(),
  user_id: text("user_id").notNull(),
  ...syncColumns,
});
export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  channel_id: text("channel_id").notNull(), // ← bucket key
  author_id: text("author_id").notNull(),
  body: text("body").notNull(),
  // HLC-ordered send time; the server is authoritative on total order within the bucket (DO serial writes).
  sent_at: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});
export const reactions = pgTable("reactions", {
  id: text("id").primaryKey(),
  channel_id: text("channel_id").notNull(), // ← bucket key (reactions live in the message's room)
  message_id: text("message_id").notNull(),
  user_id: text("user_id").notNull(),
  emoji: text("emoji").notNull(),
  ...syncColumns,
});

export type ChannelRow = typeof channels.$inferSelect;
export type ChannelMemberRow = typeof channelMembers.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ReactionRow = typeof reactions.$inferSelect;

// Provision object (server `schema:` + storage.provision) + base DDL (business columns only; the engine
// adds sync columns + _nizhal_* via provision, exactly like tabkeep).
export const chatSchema = {
  channels,
  channel_members: channelMembers,
  messages,
  reactions,
} as const;

export const CHAT_DDL = `
  create table channels (
    id text primary key,
    workspace_id text not null,
    name text not null,
    topic text,
    created_by text not null
  );
  create table channel_members (
    id text primary key,
    workspace_id text not null,
    channel_id text not null,
    user_id text not null
  );
  create table messages (
    id text primary key,
    channel_id text not null,
    author_id text not null,
    body text not null,
    sent_at timestamptz not null default now()
  );
  create table reactions (
    id text primary key,
    channel_id text not null,
    message_id text not null,
    user_id text not null,
    emoji text not null
  );
`;

const id = z.string().min(1);

// Mutators are the only way state changes — they run optimistically on the local replica AND
// authoritatively in the channel bucket (same code, two executors). `affectedBuckets` is the DO
// routing decision: which room(s) to poke. For chat it is always the message's own channel.
export const chatMutators = defineMutators({
  createChannel: defineMutator(
    z.object({ id, workspaceId: id, name: z.string().trim().min(1), topic: z.string().optional() }),
    async ({ tx, actor }, args) => {
      await tx.insert(channels).values({
        id: args.id,
        workspace_id: args.workspaceId,
        name: args.name,
        topic: args.topic ?? null,
        created_by: actor.userId,
      });
      // creator is the first member (the DO's first access-list entry). Channels + memberships live in
      // the WORKSPACE bucket, so creating a channel is allowed (you're a workspace member) and the
      // member list syncs to the whole workspace — this is what lets the channel bucket authorize you.
      await tx.insert(channelMembers).values({
        id: `${args.id}:${actor.userId}`,
        workspace_id: args.workspaceId,
        channel_id: args.id,
        user_id: actor.userId,
      });
      return { serverId: args.id, affectedBuckets: [args.workspaceId] };
    },
  ),
  joinChannel: defineMutator(
    z.object({ workspaceId: id, channelId: id, userId: id.optional() }),
    async ({ tx, actor }, args) => {
      const member = args.userId ?? actor.userId;
      await tx.insert(channelMembers).values({
        id: `${args.channelId}:${member}`,
        workspace_id: args.workspaceId,
        channel_id: args.channelId,
        user_id: member,
      });
      return { affectedBuckets: [args.workspaceId] };
    },
  ),
  sendMessage: defineMutator(
    z.object({ id, channelId: id, body: z.string().trim().min(1) }),
    async ({ tx, actor, now }, args) => {
      await tx.insert(messages).values({
        id: args.id,
        channel_id: args.channelId,
        author_id: actor.userId,
        body: args.body,
        sent_at: new Date(now()),
      });
      return { serverId: args.id, affectedBuckets: [args.channelId] };
    },
  ),
  react: defineMutator(
    z.object({ id, channelId: id, messageId: id, emoji: z.string().min(1) }),
    async ({ tx, actor }, args) => {
      await tx.insert(reactions).values({
        id: args.id,
        channel_id: args.channelId,
        message_id: args.messageId,
        user_id: actor.userId,
        emoji: args.emoji,
      });
      return { affectedBuckets: [args.channelId] };
    },
  ),
});

// Sync rule = the DO membership check. A device subscribes to the `channel:<id>` bucket only for
// channels it is a member of; the bucket then streams that channel's messages/reactions. One bucket
// per channel = one DO per room = parallel rooms, isolated ordering, scoped fan-out.
export const chatSyncRules = defineSyncRules(
  (b: SyncRuleBuilder): SyncRules =>
    ({
      // Workspace bucket: the channel directory + the membership list. Owner-gated (actor.ownerId ==
      // workspace_id) so any workspace member can create a channel and see who is in each one. This is
      // what makes channel creation possible — and it seeds the membership rows the channel rule reads.
      workspace: b.bucket({
        parameters: () => b.params({ ownerId: "workspace_id" }),
        data: (bucket) => [
          b.table("channels").where(b.eq("workspace_id", bucket.ownerId)),
          b.table("channel_members").where(b.eq("workspace_id", bucket.ownerId)),
        ],
      }),
      // Channel bucket: one DO per room. Membership-gated, resolved server-side from
      //   SELECT channel_id AS channelId FROM channel_members WHERE user_id = <actor.userId>
      // A non-member physically cannot read or post. Messages fan out per-room — the DO boundary.
      channel: b.bucket({
        parameters: (actor) =>
          b.membership({
            table: "channel_members",
            where: { user_id: actor.userId },
            select: { channelId: "channel_id" },
          }),
        data: (bucket) => [
          b.table("messages").where(b.eq("channel_id", bucket.channelId)),
          b.table("reactions").where(b.eq("channel_id", bucket.channelId)),
        ],
      }),
    }) as unknown as SyncRules,
);

// Fold: derive the visible message list for a channel off the local replica (instant, offline).
export function channelTimeline(rows: readonly MessageRow[], channelId: string): MessageRow[] {
  return rows
    .filter((m) => m.channel_id === channelId && m.deleted_at == null)
    .sort((a, b) => +new Date(a.sent_at) - +new Date(b.sent_at));
}
