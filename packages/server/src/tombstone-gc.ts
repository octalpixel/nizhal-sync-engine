import { sql } from "drizzle-orm";
import { type NizhalDb, executeRows } from "./drizzle-db.js";
import { nizhalJobs } from "./engine-tables.js";
import type { JobTask } from "./jobs.js";

export const TOMBSTONE_GC_SLUG = "_nizhal_tombstone_gc";
/** D4 default: keep tombstones 30 days. Long enough that a genuinely-offline client returns before
 *  its deletions are pruned; short enough to bound sidecar growth. */
export const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOMBSTONE_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Prune tombstones older than the retention window and advance the GC horizon in ONE transaction —
 * so a concurrent pull can never see pruned tombstones without the matching horizon (which would let
 * a straddling client miss a deletion). The horizon is monotonic (moves forward only) and set to the
 * greatest row_version among the pruned tombstones: any client whose cursor is strictly below it may
 * have missed one of those deletions and is forced to re-bootstrap (see normalizePullCursor / T9).
 * Returns how many tombstones were pruned and the new horizon (null when nothing was pruned).
 */
export async function runTombstoneGc(
  db: NizhalDb,
  retentionMs: number,
): Promise<{ pruned: number; horizon: string | null }> {
  return db.transaction(async (tx) => {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const stat = await executeRows<{ cnt: number; max_version: string | null }>(
      tx,
      sql`select count(*)::int as cnt, max(row_version)::text as max_version
          from _nizhal_tombstones where deleted_at < ${cutoff}::timestamptz`,
    );
    const pruned = Number(stat[0]?.cnt ?? 0);
    const horizon = stat[0]?.max_version ?? null;
    if (pruned === 0 || horizon === null) return { pruned: 0, horizon: null };
    await tx.execute(sql`delete from _nizhal_tombstones where deleted_at < ${cutoff}::timestamptz`);
    await tx.execute(sql`
      update _nizhal_sync_control
      set tombstone_horizon = ${horizon}::xid8, updated_at = now()
      where id = true and (tombstone_horizon is null or tombstone_horizon < ${horizon}::xid8)`);
    return { pruned, horizon };
  });
}

/**
 * The built-in tombstone-GC job. Runs the prune, drops this slug's finished job rows (so `_nizhal_jobs`
 * stays bounded), then queues the next run — a durable self-perpetuating cron. Registered automatically
 * by `createNizhalServer` unless `tombstoneRetention: false`.
 */
export function createTombstoneGcTask(opts: {
  db: NizhalDb;
  retentionMs: number;
  intervalMs?: number;
}): JobTask {
  const intervalMs = opts.intervalMs ?? DEFAULT_TOMBSTONE_GC_INTERVAL_MS;
  return {
    slug: TOMBSTONE_GC_SLUG,
    maxAttempts: 1,
    async run() {
      await runTombstoneGc(opts.db, opts.retentionMs);
      await opts.db.execute(sql`
        delete from _nizhal_jobs
        where task_slug = ${TOMBSTONE_GC_SLUG} and status in ('succeeded', 'dead_letter')`);
      await enqueueGc(opts.db, intervalMs);
    },
  };
}

/** Queue the first GC run if none is already queued/running — called when the worker starts. */
export async function seedTombstoneGc(
  db: NizhalDb,
  intervalMs: number = DEFAULT_TOMBSTONE_GC_INTERVAL_MS,
): Promise<void> {
  const existing = await executeRows<{ cnt: number }>(
    db,
    sql`select count(*)::int as cnt from _nizhal_jobs
        where task_slug = ${TOMBSTONE_GC_SLUG} and status in ('queued', 'running')`,
  );
  if (Number(existing[0]?.cnt ?? 0) > 0) return;
  await enqueueGc(db, intervalMs);
}

async function enqueueGc(db: NizhalDb, delayMs: number): Promise<void> {
  await db.insert(nizhalJobs).values({
    taskSlug: TOMBSTONE_GC_SLUG,
    input: {},
    runAt: new Date(Date.now() + delayMs),
    maxAttempts: 1,
  });
}
