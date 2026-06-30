import type { Cursor } from "@nizhal/kernel";
import { count, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { RealtimeAdapter, RealtimeStats } from "./adapters/realtime.js";
import type { NizhalDb } from "./drizzle-db.js";
import {
  nizhalClientBuckets,
  nizhalJobs,
  nizhalMutations,
  nizhalTombstones,
} from "./engine-tables.js";

export interface NizhalObserver {
  onPull?(e: {
    actor: { userId: string; ownerId: string };
    clientId?: string;
    cursor: Cursor;
    rows: number;
    tombstones: number;
    durationMs: number;
  }): void;
  onPush?(e: {
    actor: { userId: string; ownerId: string };
    clientId?: string;
    mutator: string;
    clientMutationId: string;
    ok: boolean;
    durationMs: number;
  }): void;
  onConflict?(e: {
    mutator: string;
    table: string;
    rowId: string;
    resolution: "lww" | "merge" | "reject";
  }): void;
  onError?(e: {
    phase: "pull" | "push" | "job" | "blob";
    code: string;
    clientMutationId?: string;
    error: unknown;
  }): void;
}

export const noopObserver: NizhalObserver = {};

export function safeObserver(observer: NizhalObserver = noopObserver): NizhalObserver {
  return {
    onPull: wrap(observer.onPull),
    onPush: wrap(observer.onPush),
    onConflict: wrap(observer.onConflict),
    onError: wrap(observer.onError),
  };
}

function wrap<T extends unknown[]>(fn?: (...args: T) => void): ((...args: T) => void) | undefined {
  if (!fn) return undefined;
  return (...args: T) => {
    try {
      fn(...args);
    } catch (error) {
      console.error("[@nizhal/server] observer hook threw; swallowing:", error);
    }
  };
}

export interface NizhalStats {
  buckets: Array<{ bucketKey: string; rowCount: number; clients: number }>;
  mutations: { appliedTotal: number; lastAppliedAt: string | null };
  deadLetter: {
    count: number;
    items: Array<{ clientMutationId: string; mutator: string | null; lastError: string }>;
  };
  jobs: { queued: number; running: number; failed: number };
  subscriptions: RealtimeStats;
  tombstones: { sinceLastHour: number };
}

export async function gatherStats(db: NizhalDb, realtime?: RealtimeAdapter): Promise<NizhalStats> {
  const sinceHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [bucketRows, mutationRow, deadLetterJobs, deadLetterMutations, jobRows, tombstoneRow] =
    await Promise.all([
      db
        .select({
          bucketKey: nizhalClientBuckets.bucketKey,
          clients: count(nizhalClientBuckets.clientId),
        })
        .from(nizhalClientBuckets)
        .groupBy(nizhalClientBuckets.bucketKey),
      db
        .select({
          total: count(nizhalMutations.clientMutationId),
          lastAppliedAt: sql<string | null>`max(${nizhalMutations.appliedAt})`,
        })
        .from(nizhalMutations),
      db
        .select({
          id: nizhalJobs.id,
          taskSlug: nizhalJobs.taskSlug,
          lastError: nizhalJobs.lastError,
        })
        .from(nizhalJobs)
        .where(eq(nizhalJobs.status, "dead_letter")),
      db
        .select({
          clientMutationId: nizhalMutations.clientMutationId,
          error: nizhalMutations.error,
        })
        .from(nizhalMutations)
        .where(isNotNull(nizhalMutations.error)),
      db
        .select({ status: nizhalJobs.status, count: count() })
        .from(nizhalJobs)
        .groupBy(nizhalJobs.status),
      db
        .select({ count: count() })
        .from(nizhalTombstones)
        .where(gte(nizhalTombstones.deletedAt, sinceHourAgo)),
    ]);

  const buckets = bucketRows.map((row) => ({
    bucketKey: row.bucketKey,
    rowCount: 0,
    clients: Number(row.clients),
  }));

  const jobCounts = { queued: 0, running: 0, failed: 0 };
  for (const row of jobRows) {
    if (row.status === "queued") jobCounts.queued = Number(row.count);
    if (row.status === "running") jobCounts.running = Number(row.count);
  }
  jobCounts.failed = deadLetterJobs.length;

  const deadLetterItems = [
    ...deadLetterJobs.map((job) => ({
      clientMutationId: String(job.id),
      mutator: job.taskSlug,
      lastError: job.lastError ?? "",
    })),
    ...deadLetterMutations.map((m) => ({
      clientMutationId: m.clientMutationId,
      mutator: null as string | null,
      lastError: m.error ?? "",
    })),
  ];

  return {
    buckets,
    mutations: {
      appliedTotal: Number(mutationRow[0]?.total ?? 0),
      lastAppliedAt: mutationRow[0]?.lastAppliedAt ?? null,
    },
    deadLetter: {
      count: deadLetterItems.length,
      items: deadLetterItems,
    },
    jobs: jobCounts,
    subscriptions: realtime?.stats?.() ?? { activeSubscriptions: 0 },
    tombstones: { sinceLastHour: Number(tombstoneRow[0]?.count ?? 0) },
  };
}

export function adminPassword(): string | undefined {
  return process.env.NIZHAL_ADMIN_PASSWORD;
}

export function isAdminAuthorized(req: Request, password: string): boolean {
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const urlToken = new URL(req.url).searchParams.get("admin_password");
  const candidate = token ?? urlToken;
  if (!candidate) return false;
  const expected = Buffer.from(password);
  const actual = Buffer.from(candidate);
  if (expected.length !== actual.length) return false;
  return timingSafeEqualBuffers(expected, actual);
}

function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.readUInt8(i) ^ b.readUInt8(i);
  }
  return result === 0;
}
