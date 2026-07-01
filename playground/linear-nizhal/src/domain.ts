// Linear — Nizhal domain. Same Durable-Objects first principle, one level up:
//
//   A TEAM is a Durable Object; when a team gets big, a PROJECT is a child Durable Object.
//
// The DO blog's "apartment building" pattern maps exactly to sync buckets. The building (team) is a
// bucket that holds the registry + everything small; each apartment (project) can be its own bucket so
// 50 people working different projects don't serialize behind one room. In Nizhal: the bucket key is
// the consistency + fan-out + authz boundary. We bucket by TEAM by default (one DO per team), and the
// `affectedBuckets` of every mutator names the team(s) to poke. If a team outgrows one bucket, switch
// the bucket key to `project` — a pure decomposition, no schema change (the DO parent-child split).
import {
  type SyncRuleBuilder,
  type SyncRules,
  defineMutator,
  defineMutators,
  defineSyncRules,
  z,
} from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};

// `team_id` is the bucket key (the DO id) on every syncable row.
export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull(), // e.g. "ENG" → issue identifiers ENG-123
  ...syncColumns,
});
export const teamMembers = pgTable("team_members", {
  id: text("id").primaryKey(),
  team_id: text("team_id").notNull(),
  user_id: text("user_id").notNull(),
  ...syncColumns,
});
export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  team_id: text("team_id").notNull(), // ← bucket key
  name: text("name").notNull(),
  ...syncColumns,
});
export const issues = pgTable("issues", {
  id: text("id").primaryKey(),
  team_id: text("team_id").notNull(), // ← bucket key
  project_id: text("project_id"),
  number: integer("number").notNull(), // ENG-<number>; assigned by the mutator
  title: text("title").notNull(),
  description: text("description"),
  status: text("status", {
    enum: ["backlog", "todo", "in_progress", "done", "canceled"],
  }).notNull(),
  priority: integer("priority").notNull(), // 0 none … 4 urgent
  assignee_id: text("assignee_id"),
  ...syncColumns,
});
export const comments = pgTable("comments", {
  id: text("id").primaryKey(),
  team_id: text("team_id").notNull(), // ← bucket key (comment lives in the issue's team room)
  issue_id: text("issue_id").notNull(),
  author_id: text("author_id").notNull(),
  body: text("body").notNull(),
  ...syncColumns,
});

export type IssueRow = typeof issues.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;

const id = z.string().min(1);
const status = z.enum(["backlog", "todo", "in_progress", "done", "canceled"]);
const priority = z.number().int().min(0).max(4);

export const linearMutators = defineMutators({
  createTeam: defineMutator(
    z.object({ id, name: z.string().trim().min(1), key: z.string().trim().min(1) }),
    async ({ tx, actor }, args) => {
      await tx.insert(teams).values({ id: args.id, name: args.name, key: args.key });
      await tx.insert(teamMembers).values({
        id: `${args.id}:${actor.userId}`,
        team_id: args.id,
        user_id: actor.userId,
      });
      return { serverId: args.id, affectedBuckets: [`team:${args.id}`] };
    },
  ),
  createIssue: defineMutator(
    z.object({
      id,
      teamId: id,
      number: z.number().int().positive(),
      title: z.string().trim().min(1),
      description: z.string().optional(),
      projectId: id.optional(),
      priority: priority.optional(),
    }),
    async ({ tx, actor }, args) => {
      await tx.insert(issues).values({
        id: args.id,
        team_id: args.teamId,
        project_id: args.projectId ?? null,
        number: args.number,
        title: args.title,
        description: args.description ?? null,
        status: "todo",
        priority: args.priority ?? 0,
        assignee_id: actor.userId,
      });
      return { serverId: args.id, affectedBuckets: [`team:${args.teamId}`] };
    },
  ),
  // The verb a tracker lives on: move a card. Optimistic locally (instant drag), authoritative in the
  // team bucket. Last-writer-wins on the field via HLC; the bucket gives total order so two devices
  // dragging the same issue converge.
  updateIssueStatus: defineMutator(
    z.object({ teamId: id, issueId: id, status }),
    async ({ tx }, args) => {
      await tx.update(issues, { id: args.issueId }).set({ status: args.status });
      return { affectedBuckets: [`team:${args.teamId}`] };
    },
  ),
  assignIssue: defineMutator(
    z.object({ teamId: id, issueId: id, assigneeId: id.nullable() }),
    async ({ tx }, args) => {
      await tx.update(issues, { id: args.issueId }).set({ assignee_id: args.assigneeId });
      return { affectedBuckets: [`team:${args.teamId}`] };
    },
  ),
  comment: defineMutator(
    z.object({ id, teamId: id, issueId: id, body: z.string().trim().min(1) }),
    async ({ tx, actor }, args) => {
      await tx.insert(comments).values({
        id: args.id,
        team_id: args.teamId,
        issue_id: args.issueId,
        author_id: actor.userId,
        body: args.body,
      });
      return { affectedBuckets: [`team:${args.teamId}`] };
    },
  ),
});

// One bucket per team (one DO per team). A device syncs a team only if it is a member. Switch the
// bucket key from team_id → project_id here to shard a huge team into per-project DOs — no other change.
export const linearSyncRules = defineSyncRules(
  (b: SyncRuleBuilder): SyncRules =>
    ({
      team: b.bucket({
        parameters: () => b.params({ teamId: "team_id" }),
        data: (bucket) => [
          b.table("teams").where(b.eq("id", bucket.teamId)),
          b.table("team_members").where(b.eq("team_id", bucket.teamId)),
          b.table("projects").where(b.eq("team_id", bucket.teamId)),
          b.table("issues").where(b.eq("team_id", bucket.teamId)),
          b.table("comments").where(b.eq("team_id", bucket.teamId)),
        ],
      }),
    }) as unknown as SyncRules,
);

// Fold: a board column off the local replica (instant, offline).
export function issuesByStatus(rows: readonly IssueRow[], teamId: string, s: IssueRow["status"]) {
  return rows
    .filter((i) => i.team_id === teamId && i.deleted_at == null && i.status === s)
    .sort((a, b) => b.priority - a.priority);
}
