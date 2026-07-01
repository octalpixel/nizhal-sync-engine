// MAXIMALLY-RELATIONAL offline→online stress test against REAL hosted Postgres (Neon).
// Domain (a project tracker): 1:N (project→issues), M:N (issue↔labels via join), self-referential
// (issue blocking + threaded comments), a server-meaningful per-workspace issue NUMBER, and a deep
// ATOMIC multi-table cascade (one mutator writes issue + N issue_labels + a comment). All entities live
// in one membership-gated `space` bucket (workspace_id), so the whole graph syncs as a unit.
//
// Run: cd playground/chat-nizhal && DATABASE_URL=<neon> pnpm exec tsx examples/relgraph-neon.ts
import {
  createNizhalClient,
  createNizhalMutators,
  manualOnlineDetector,
  nizhalCollectionOptions,
  type NizhalCollection,
} from "@nizhal/db-collection";
import { bearerTokenAuth, createNizhalServer, issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import {
  type MutatorRegistry,
  type SyncRuleBuilder,
  type SyncRules,
  defineMutator,
  defineMutators,
  defineSyncRules,
  z,
} from "@nizhal/kernel";
import { createCollection } from "@tanstack/db";
import { eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { appendFileSync, writeFileSync } from "node:fs";
const PROGRESS="/tmp/relgraph-progress.log";
const RESULT="/tmp/relgraph-result.json";

const SECRET = "relgraph-secret";
const ORG = "org";

// ── schema (business columns only; provision layers _nizhal_* + sync columns + triggers) ──
const members = pgTable("rg_members", { id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(), user_id: text("user_id").notNull() });
const projects = pgTable("rg_projects", { id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(), name: text("name").notNull() });
const labels = pgTable("rg_labels", { id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(), name: text("name").notNull() });
const issues = pgTable("rg_issues", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  project_id: text("project_id"), // 1:N → rg_projects
  parent_issue_id: text("parent_issue_id"), // self-ref: blocked-by
  number: integer("number").notNull(), // per-workspace identifier (server-meaningful)
  title: text("title").notNull(),
  author_id: text("author_id").notNull(),
});
const issueLabels = pgTable("rg_issue_labels", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  issue_id: text("issue_id").notNull(), // M:N → rg_issues
  label_id: text("label_id").notNull(), // M:N → rg_labels
});
const comments = pgTable("rg_comments", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  issue_id: text("issue_id").notNull(), // → rg_issues
  parent_comment_id: text("parent_comment_id"), // self-ref: threaded
  body: text("body").notNull(),
  author_id: text("author_id").notNull(),
});

const relSchema = { rg_members: members, rg_projects: projects, rg_labels: labels, rg_issues: issues, rg_issue_labels: issueLabels, rg_comments: comments } as const;

const REL_DDL = `
  create table rg_members (id text primary key, workspace_id text not null, user_id text not null);
  create table rg_projects (id text primary key, workspace_id text not null, name text not null);
  create table rg_labels (id text primary key, workspace_id text not null, name text not null);
  create table rg_issues (id text primary key, workspace_id text not null, project_id text, parent_issue_id text, number integer not null, title text not null, author_id text not null);
  create table rg_issue_labels (id text primary key, workspace_id text not null, issue_id text not null, label_id text not null);
  create table rg_comments (id text primary key, workspace_id text not null, issue_id text not null, parent_comment_id text, body text not null, author_id text not null);
`;

const sid = z.string().min(1);
const relMutators = defineMutators({
  createProject: defineMutator(z.object({ id: sid, workspaceId: sid, name: z.string().min(1) }), async ({ tx }, a) => {
    await tx.insert(projects).values({ id: a.id, workspace_id: a.workspaceId, name: a.name });
    return { serverId: a.id, affectedBuckets: [a.workspaceId] };
  }),
  createLabel: defineMutator(z.object({ id: sid, workspaceId: sid, name: z.string().min(1) }), async ({ tx }, a) => {
    await tx.insert(labels).values({ id: a.id, workspace_id: a.workspaceId, name: a.name });
    return { serverId: a.id, affectedBuckets: [a.workspaceId] };
  }),
  // DEEP ATOMIC CASCADE: one transaction → issue + its label links + an opening comment.
  createIssueCascade: defineMutator(
    z.object({ id: sid, workspaceId: sid, projectId: sid.optional(), number: z.number().int().positive(), title: z.string().min(1), labelIds: z.array(sid), commentId: sid, commentBody: z.string().min(1) }),
    async ({ tx, actor }, a) => {
      await tx.insert(issues).values({ id: a.id, workspace_id: a.workspaceId, project_id: a.projectId ?? null, parent_issue_id: null, number: a.number, title: a.title, author_id: actor.userId });
      for (const labelId of a.labelIds) {
        await tx.insert(issueLabels).values({ id: `${a.id}:${labelId}`, workspace_id: a.workspaceId, issue_id: a.id, label_id: labelId });
      }
      await tx.insert(comments).values({ id: a.commentId, workspace_id: a.workspaceId, issue_id: a.id, parent_comment_id: null, body: a.commentBody, author_id: actor.userId });
      return { serverId: a.id, affectedBuckets: [a.workspaceId] };
    },
  ),
  reply: defineMutator(z.object({ id: sid, workspaceId: sid, issueId: sid, parentCommentId: sid, body: z.string().min(1) }), async ({ tx, actor }, a) => {
    await tx.insert(comments).values({ id: a.id, workspace_id: a.workspaceId, issue_id: a.issueId, parent_comment_id: a.parentCommentId, body: a.body, author_id: actor.userId });
    return { serverId: a.id, affectedBuckets: [a.workspaceId] };
  }),
  linkBlocking: defineMutator(z.object({ workspaceId: sid, issueId: sid, blockedById: sid }), async ({ tx }, a) => {
    await tx.update(issues).set({ parent_issue_id: a.blockedById }).where(eq(issues.id, a.issueId));
    return { affectedBuckets: [a.workspaceId] };
  }),
});

const relSyncRules = defineSyncRules(
  (b: SyncRuleBuilder): SyncRules =>
    ({
      space: b.bucket({
        parameters: (actor) => b.membership({ table: "rg_members", where: { user_id: actor.userId }, select: { spaceId: "workspace_id" } }),
        data: (bucket) => [
          b.table("rg_projects").where(b.eq("workspace_id", bucket.spaceId)),
          b.table("rg_labels").where(b.eq("workspace_id", bucket.spaceId)),
          b.table("rg_issues").where(b.eq("workspace_id", bucket.spaceId)),
          b.table("rg_issue_labels").where(b.eq("workspace_id", bucket.spaceId)),
          b.table("rg_comments").where(b.eq("workspace_id", bucket.spaceId)),
        ],
      }),
    }) as unknown as SyncRules,
);

// ── client builder (mirrors chat's client.ts wiring) ──
type AnyRow = Record<string, unknown> & { id: string };
async function makeClient(opts: { baseUrl: string; userId: string; spaces: string[]; realtime: ReturnType<typeof inProcessRealtime> }) {
  const token = issueBearerToken({ secret: SECRET, userId: opts.userId, ownerId: ORG });
  const echo = createNizhalClient({
    server: opts.baseUrl,
    auth: { headers: { authorization: `Bearer ${token}` } },
    subscribeSource: { subscribe: (buckets, onMessage) => opts.realtime.subscribe(buckets, { send: onMessage }) },
    bucketsForSyncRule: (rule) => (rule === "space" ? opts.spaces : []),
  });
  const coll = (name: string) =>
    createCollection(nizhalCollectionOptions<AnyRow>({ name, syncRule: "space", echo, bucketField: "workspace_id", getKey: (r) => r.id })) as NizhalCollection<AnyRow>;
  // NB: the collections map MUST be keyed by the drizzle TABLE NAME — the client mutator ctx resolves
  // `tx.insert(table)` to a collection via getTableName(table).
  const projects = coll("rg_projects"), labels = coll("rg_labels"), issues = coll("rg_issues"), issueLabels = coll("rg_issue_labels"), comments = coll("rg_comments");
  await Promise.all([projects, labels, issues, issueLabels, comments].map((x) => x.preload()));
  const onlineDetector = manualOnlineDetector();
  const m = createNizhalMutators({
    collections: { rg_projects: projects, rg_labels: labels, rg_issues: issues, rg_issue_labels: issueLabels, rg_comments: comments } as unknown as Record<string, NizhalCollection<object>>,
    echo,
    actor: { userId: opts.userId, ownerId: ORG },
    mutators: relMutators,
    onlineDetector,
  });
  await m.executor.waitForInit();
  return { projects, labels, issues, issueLabels, comments, echo, onlineDetector, mutate: m.mutate, waitForIdle: m.waitForIdle, dispose: m.dispose };
}

async function pullSpace(client: Awaited<ReturnType<typeof makeClient>>) {
  // Resilient against transient remote-Neon blips (region latency / pooler hiccups). A failure that
  // survives all retries is a real apply bug, not flakiness.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.echo.pull({ cursor: client.echo.getCursor("space"), syncRule: "space" });
      return;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required (real Postgres / Neon)");
  const host = url.replace(/^[a-z]+:\/\/[^@]*@/, "").split("/")[0];
  console.log(`▶ relationship-heavy offline→online on REAL Postgres: ${host}`);
  const t0 = Date.now();
  const step = (m: string) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; console.log("  "+l); appendFileSync(PROGRESS, l+"\n"); };
  const sql = postgres(url, { max: 8, onnotice: () => {} });
  const storage = postgresStorage({ connectionString: url });
  await sql.unsafe("drop table if exists rg_comments, rg_issue_labels, rg_issues, rg_labels, rg_projects, rg_members cascade");
  await sql.unsafe(REL_DDL);
  await storage.provision({ schema: relSchema, syncRules: relSyncRules });
  step("provisioned");

  const realtime = inProcessRealtime();
  const server = createNizhalServer({ db: url, schema: relSchema, mutators: relMutators as MutatorRegistry, syncRules: relSyncRules, auth: bearerTokenAuth({ secret: SECRET }), storage, realtime });
  const listener = server.listen(0);
  await new Promise<void>((r) => listener.once("listening", () => r()));
  const baseUrl = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  step("server up");

  const W = "ws-main";
  const W2 = "ws-other";
  // Seed memberships directly (membership grant is an admin/server action, not a synced mutator).
  await sql.unsafe(`insert into rg_members (id, workspace_id, user_id) values
    ('m-alice', '${W}', 'alice'), ('m-bob', '${W}', 'bob'), ('m-carol', '${W}', 'carol'),
    ('m-dave-w2', '${W2}', 'dave'), ('m-eve-w2', '${W2}', 'eve')`);
  step("memberships seeded");

  // Online seed: alice creates a project + two labels in W.
  const alice = await makeClient({ baseUrl, userId: "alice", spaces: [W], realtime });
  alice.mutate.createProject({ id: "p1", workspaceId: W, name: "Roadmap" });
  alice.mutate.createLabel({ id: "lbl-bug", workspaceId: W, name: "bug" });
  alice.mutate.createLabel({ id: "lbl-urgent", workspaceId: W, name: "urgent" });
  await alice.waitForIdle();
  step("online seed pushed (project+2 labels)");

  const bob = await makeClient({ baseUrl, userId: "bob", spaces: [W], realtime });
  await pullSpace(bob);
  step("bob synced");

  // ── OFFLINE phase ──
  alice.onlineDetector.setOnline(false);
  bob.onlineDetector.setOnline(false);

  // alice (offline): a deep cascade + a threaded reply + a self-ref blocking link.
  alice.mutate.createIssueCascade({ id: "i1", workspaceId: W, projectId: "p1", number: 1, title: "Login broken", labelIds: ["lbl-bug", "lbl-urgent"], commentId: "c1", commentBody: "repro on iOS" });
  alice.mutate.createIssueCascade({ id: "i2", workspaceId: W, projectId: "p1", number: 2, title: "Add SSO", labelIds: ["lbl-urgent"], commentId: "c2", commentBody: "spec needed" });
  alice.mutate.reply({ id: "c1r", workspaceId: W, issueId: "i1", parentCommentId: "c1", body: "also Android" });
  alice.mutate.linkBlocking({ workspaceId: W, issueId: "i1", blockedById: "i2" }); // i1 blocked by i2 (self-ref)

  // bob (offline): creates an issue with number=1 too — the classic offline server-sequence COLLISION.
  bob.mutate.createIssueCascade({ id: "i3", workspaceId: W, projectId: "p1", number: 1, title: "Dark mode", labelIds: ["lbl-bug"], commentId: "c3", commentBody: "design ready" });

  console.log(`  offline: alice queued i1(+2 labels,+comment)+i2+reply+blocking; bob queued i3 (number=1 COLLISION)`);

  // ── RECONNECT ──
  alice.onlineDetector.setOnline(true);
  bob.onlineDetector.setOnline(true);
  await alice.waitForIdle();
  await bob.waitForIdle();
  await new Promise((r) => setTimeout(r, 800));
  step("reconnected + flushed");

  // Fresh client carol bootstraps W and must converge to the full graph.
  const carol = await makeClient({ baseUrl, userId: "carol", spaces: [W], realtime });
  // page until caught up
  for (let i = 0; i < 6; i++) await pullSpace(carol);
  step("carol converged");

  const cIssues = carol.issues.toArray as AnyRow[];
  const cLabels = carol.labels.toArray as AnyRow[];
  const cLinks = carol.issueLabels.toArray as AnyRow[];
  const cComments = carol.comments.toArray as AnyRow[];
  const cProjects = carol.projects.toArray as AnyRow[];
  console.log(`\n  carol converged: issues=[${ids(cIssues)}] labels=[${ids(cLabels)}] issue_labels=${cLinks.length} comments=[${ids(cComments)}] projects=[${ids(cProjects)}]`);

  // (1) Referential integrity over the converged replica.
  const issueIds = new Set(cIssues.map((r) => r.id));
  const labelIds = new Set(cLabels.map((r) => r.id));
  const projIds = new Set(cProjects.map((r) => r.id));
  const commentIds = new Set(cComments.map((r) => r.id));
  const dangling: string[] = [];
  for (const l of cLinks) {
    if (!issueIds.has(l.issue_id as string)) dangling.push(`issue_label ${l.id} → missing issue ${l.issue_id}`);
    if (!labelIds.has(l.label_id as string)) dangling.push(`issue_label ${l.id} → missing label ${l.label_id}`);
  }
  for (const cm of cComments) {
    if (!issueIds.has(cm.issue_id as string)) dangling.push(`comment ${cm.id} → missing issue ${cm.issue_id}`);
    if (cm.parent_comment_id && !commentIds.has(cm.parent_comment_id as string)) dangling.push(`comment ${cm.id} → missing parent ${cm.parent_comment_id}`);
  }
  for (const is of cIssues) {
    if (is.project_id && !projIds.has(is.project_id as string)) dangling.push(`issue ${is.id} → missing project ${is.project_id}`);
    if (is.parent_issue_id && !issueIds.has(is.parent_issue_id as string)) dangling.push(`issue ${is.id} → missing blocker ${is.parent_issue_id}`);
  }
  console.log(`  (1) referential integrity: ${dangling.length === 0 ? "✅ no dangling references" : `🔴 ${dangling.length} DANGLING:\n     - ${dangling.join("\n     - ")}`}`);

  // (2) Atomic cascade: i1 present WITH both labels + opening comment (none lost on offline replay).
  const i1Labels = cLinks.filter((l) => l.issue_id === "i1").map((l) => l.label_id).sort();
  const i1Comment = cComments.some((c) => c.id === "c1");
  const cascadeOk = issueIds.has("i1") && i1Labels.join(",") === "lbl-bug,lbl-urgent" && i1Comment;
  console.log(`  (2) atomic cascade i1: issue=${issueIds.has("i1")} labels=[${i1Labels}] comment=${i1Comment} → ${cascadeOk ? "✅ intact" : "🔴 PARTIAL/LOST"}`);

  // (3) Number collision under offline (the server-computed-sequence hazard).
  const dbNums = await sql.unsafe<{ number: number; count: number }[]>(
    `select number, count(*)::int as count from rg_issues where workspace_id = '${W}' group by number having count(*) > 1`,
  );
  console.log(`  (3) issue-number collisions (server truth): ${dbNums.length === 0 ? "✅ none" : `🔴 duplicate numbers: ${JSON.stringify(dbNums)} → two issues share an identifier`}`);

  // (4) No lost write: all three issues converged.
  const allIssues = issueIds.has("i1") && issueIds.has("i2") && issueIds.has("i3");
  console.log(`  (4) convergence: all of i1,i2,i3 present on a fresh client → ${allIssues ? "✅" : "🔴 LOST a write"}`);

  // ── G1-on-a-graph: dave is active in W2 (cursor advances past W's graph), then JOINS W. ──
  const eve = await makeClient({ baseUrl, userId: "eve", spaces: [W2], realtime });
  eve.mutate.createProject({ id: "p-w2", workspaceId: W2, name: "Other" });
  eve.mutate.createIssueCascade({ id: "w2-i1", workspaceId: W2, number: 1, title: "other work", labelIds: [], commentId: "w2-c1", commentBody: "x" });
  await eve.waitForIdle();
  const daveSpaces = [W2];
  const dave = await makeClient({ baseUrl, userId: "dave", spaces: daveSpaces, realtime });
  for (let i = 0; i < 4; i++) await pullSpace(dave); // dave's space cursor advances past W's (older) graph
  // dave joins W (membership granted server-side) + adds W to its synced buckets (live array).
  await sql.unsafe(`insert into rg_members (id, workspace_id, user_id) values ('m-dave-w', '${W}', 'dave')`);
  daveSpaces.push(W);
  for (let i = 0; i < 4; i++) await pullSpace(dave);
  const daveW = (dave.issues.toArray as AnyRow[]).filter((r) => r.workspace_id === W);
  console.log(`\n  (G1-graph) dave joined W (server has i1,i2,i3) — dave's replica for W shows issues: [${ids(daveW)}]`);
  console.log(`  ${daveW.length === 0 ? "🔴 G1-on-a-graph CONFIRMED — joined a workspace, sees an EMPTY tracker (no projects/issues/labels/comments)." : daveW.length < 3 ? "🔴 PARTIAL backfill" : "✅ full graph backfilled"}`);

  await Promise.all([alice.dispose(), bob.dispose(), carol.dispose(), eve.dispose(), dave.dispose()]);
  listener.close();
  await sql.end({ timeout: 5 });

  console.log(`\n──────── RELATIONSHIP-HEAVY RESULT (REAL NEON POSTGRES) ────────`);
  console.log(`integrity=${dangling.length === 0 ? "ok" : "DANGLING"} cascade=${cascadeOk ? "ok" : "LOST"} numberCollision=${dbNums.length > 0 ? "YES(bug)" : "none"} convergence=${allIssues ? "ok" : "LOST"} g1Graph=${daveW.length === 0 ? "CONFIRMED" : "ok"}`);
  writeFileSync(RESULT, JSON.stringify({ ok:true, carolIssues: ids(cIssues), carolLabels: ids(cLabels), carolLinks: cLinks.length, carolComments: ids(cComments), dangling, cascadeOk, numberCollisions: dbNums, convergedAll: allIssues, g1GraphDaveIssues: ids(daveW) }, null, 2));
  step("DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("relgraph error:", e);
  try { writeFileSync(RESULT, JSON.stringify({ ok:false, error: String((e as Error)?.stack ?? e) })); } catch {}
  process.exit(1);
});
