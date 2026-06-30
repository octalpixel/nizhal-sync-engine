import type { JobScheduler } from "@nizhal/kernel";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  type DrizzleClient,
  type NizhalDb,
  type PgliteClient,
  type PostgresClient,
  type StorageTx,
  closeRawClient,
  toNizhalDb,
} from "./drizzle-db.js";
import { nizhalJobs } from "./engine-tables.js";

export interface JobTaskContext {
  id: number;
  input: unknown;
  attempt: number;
}

export type JobTaskHandler = (ctx: JobTaskContext) => Promise<void> | void;

export interface JobTask {
  slug: string;
  run: JobTaskHandler;
  maxAttempts?: number;
}

export type JobRegistryInput =
  | Record<string, JobTaskHandler | { run: JobTaskHandler; maxAttempts?: number }>
  | JobTask[];

export interface BufferedJobScheduler extends JobScheduler {
  flush(): Promise<void>;
}

export interface JobWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<number>;
}

export interface JobWorkerOptions {
  connectionString: string;
  tasks: JobRegistryInput;
  client?: PostgresClient | PgliteClient | DrizzleClient;
  closeClientOnStop?: boolean;
  intervalMs?: number;
  backoffMs?: (attempt: number) => number;
}

interface JobTaskDef {
  run: JobTaskHandler;
  maxAttempts?: number;
}

interface ClaimedJob {
  id: number;
  taskSlug: string;
  input: unknown;
  attempts: number;
  maxAttempts: number;
}

interface PendingJob {
  taskSlug: string;
  input: unknown;
  runAt: number;
  maxAttempts?: number;
}

export function createJobScheduler(tx: StorageTx): BufferedJobScheduler {
  const pending: PendingJob[] = [];
  return {
    enqueue(taskSlug, input, opts) {
      pending.push({
        taskSlug,
        input,
        runAt: Date.now() + Math.max(0, opts?.delayMs ?? 0),
        maxAttempts: opts?.maxAttempts,
      });
    },
    scheduleAt(at, taskSlug, input) {
      pending.push({ taskSlug, input, runAt: at });
    },
    async flush() {
      if (pending.length === 0) return;
      await tx.db.insert(nizhalJobs).values(
        pending.map((job) => ({
          taskSlug: job.taskSlug,
          input: job.input ?? null,
          runAt: new Date(job.runAt),
          maxAttempts: job.maxAttempts ?? 3,
        })),
      );
      pending.length = 0;
    },
  };
}

export function createJobWorker(options: JobWorkerOptions): JobWorker {
  const rawClient = options.client ?? postgres(options.connectionString);
  const { db } = toNizhalDb(rawClient);
  const closeClientOnStop = options.closeClientOnStop ?? true;
  const tasks = normalizeTasks(options.tasks);
  const intervalMs = options.intervalMs ?? 1000;
  const backoffMs =
    options.backoffMs ?? ((attempt: number) => Math.min(60_000, 1000 * 2 ** (attempt - 1)));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      while ((await runDueJob(db, tasks, backoffMs)) === 1) {}
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setTimeout(tick, 0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (closeClientOnStop) await closeRawClient(rawClient);
    },
    async runOnce() {
      return runDueJob(db, tasks, backoffMs);
    },
  };
}

export async function runDueJob(
  db: NizhalDb,
  tasks: Map<string, JobTaskDef>,
  backoffMs: (attempt: number) => number = (attempt) => Math.min(60_000, 1000 * 2 ** (attempt - 1)),
): Promise<number> {
  const job = await claimDueJob(db);
  if (!job) return 0;
  const task = tasks.get(job.taskSlug);
  if (!task) {
    await markJobFailed(db, job, new Error(`Unknown job task '${job.taskSlug}'`), backoffMs);
    return 1;
  }

  try {
    await task.run({ id: job.id, input: job.input, attempt: job.attempts });
    await db
      .update(nizhalJobs)
      .set({ status: "succeeded", lockedAt: null, updatedAt: sql`now()` })
      .where(eq(nizhalJobs.id, job.id));
  } catch (error) {
    await markJobFailed(db, job, error, backoffMs);
  }
  return 1;
}

export function normalizeTasks(input: JobRegistryInput | undefined): Map<string, JobTaskDef> {
  const tasks = new Map<string, JobTaskDef>();
  if (!input) return tasks;
  if (Array.isArray(input)) {
    for (const task of input)
      tasks.set(task.slug, { run: task.run, maxAttempts: task.maxAttempts });
    return tasks;
  }
  for (const [slug, task] of Object.entries(input)) {
    tasks.set(slug, typeof task === "function" ? { run: task } : task);
  }
  return tasks;
}

async function claimDueJob(db: NizhalDb): Promise<ClaimedJob | null> {
  return db.transaction((tx) => claimDueJobInTransaction(tx));
}

async function claimDueJobInTransaction(db: NizhalDb): Promise<ClaimedJob | null> {
  const rows = await db
    .select({ id: nizhalJobs.id })
    .from(nizhalJobs)
    .where(and(eq(nizhalJobs.status, "queued"), lte(nizhalJobs.runAt, sql`now()`)))
    .orderBy(asc(nizhalJobs.runAt), asc(nizhalJobs.id))
    .limit(1);
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const claimed = await db
    .update(nizhalJobs)
    .set({
      status: "running",
      attempts: sql`${nizhalJobs.attempts} + 1`,
      lockedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(nizhalJobs.id, id), eq(nizhalJobs.status, "queued")))
    .returning();
  return claimed[0] ?? null;
}

async function markJobFailed(
  db: NizhalDb,
  job: ClaimedJob,
  error: unknown,
  backoffMs: (attempt: number) => number,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (job.attempts >= job.maxAttempts) {
    await db
      .update(nizhalJobs)
      .set({
        status: "dead_letter",
        lockedAt: null,
        lastError: message,
        updatedAt: sql`now()`,
      })
      .where(eq(nizhalJobs.id, job.id));
    return;
  }
  await db
    .update(nizhalJobs)
    .set({
      status: "queued",
      lockedAt: null,
      lastError: message,
      runAt: new Date(Date.now() + backoffMs(job.attempts)),
      updatedAt: sql`now()`,
    })
    .where(eq(nizhalJobs.id, job.id));
}
