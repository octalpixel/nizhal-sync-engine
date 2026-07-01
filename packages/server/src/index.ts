import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  type Actor,
  type BucketKey,
  type ContractSchemaSource,
  INITIAL_CURSOR,
  type MergeMode,
  type Mutation,
  type MutatorCtx,
  type MutatorPredicate,
  type MutatorRegistry,
  type MutatorTx,
  type PullResult,
  type Schema,
  type SyncRules,
  assertSyncRulesNoLeak,
  createHlcClock,
  emitNizhalContract,
  isNizhalTable,
  isNizhalTableSource,
  schemaMergeMode,
  schemaTableName,
  tableColumnMergeModes,
} from "@nizhal/kernel";
import { and, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm/sql";
import type { Table } from "drizzle-orm/table";
import { getTableName } from "drizzle-orm/table";
import { getTableColumns } from "drizzle-orm/utils";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as Y from "yjs";
import { type BlobAdapter, type LocalFsBlobStore, blobDb, findBlobRef } from "./adapters/blob.js";
import {
  type RealtimeAdapter,
  type RealtimeSocket,
  inProcessRealtime,
} from "./adapters/realtime.js";
import {
  type AuditQuery,
  type StorageAdapter,
  type StorageTx,
  WriteAuthorizationError,
  postgresStorage,
} from "./adapters/storage.js";
import { type NizhalDb, executeRows, whereToPredicate } from "./drizzle-db.js";
import {
  type BufferedJobScheduler,
  type JobRegistryInput,
  createJobScheduler,
  createJobWorker,
  normalizeTasks,
} from "./jobs.js";
import {
  type NizhalObserver,
  adminPassword,
  gatherStats,
  isAdminAuthorized,
  noopObserver,
  safeObserver,
} from "./observer.js";

export interface NizhalAuth {
  /** Resolve the authenticated actor from a request (returns null to reject). */
  resolve(req: Request): Promise<{ userId: string; ownerId: string } | null>;
}

export interface NizhalServerConfig {
  db: string;
  schema: Record<string, ContractSchemaSource>;
  mutators: MutatorRegistry;
  syncRules: SyncRules;
  jobs?: JobRegistryInput;
  auth: NizhalAuth;
  /** Defaults to postgresStorage(db). */
  storage?: StorageAdapter;
  /** Defaults to inProcessRealtime(). */
  realtime?: RealtimeAdapter;
  /** Optional out-of-band blob storage adapter (S3/R2/local FS). */
  blob?: BlobAdapter;
  /** Enable CORS for cross-origin browser clients. `true` → allow any origin; or pass hono cors options. */
  cors?: boolean | Parameters<typeof cors>[0];
  /** Optional sync observability hooks. */
  observer?: NizhalObserver;
  /**
   * Safe defaults: 1 MiB request bodies and 120 sync requests per actor per minute.
   * `maxBodyBytes` — max JSON body size for sync endpoints (413 when exceeded).
   * `rateLimit` — per-actor sliding window (`ownerId:userId`); set `false` to disable.
   */
  limits?: {
    maxBodyBytes?: number;
    rateLimit?:
      | false
      | {
          windowMs?: number;
          maxRequests?: number;
        };
  };
  /** Presence heartbeat timeout before evicting stale connections (default 30s). */
  presence?: {
    heartbeatTimeoutMs?: number;
  };
  /** Persist the full applied-mutation envelope in the append-only audit log. */
  audit?: boolean;
}

export interface NizhalServer {
  app: Hono<any>;
  listen(port: number): ReturnType<typeof serve>;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;
const BODY_TOO_LARGE = Symbol("body-too-large");

class AuditQueryError extends Error {}

function parseAuditQuery(req: Request): AuditQuery {
  const params = new URL(req.url).searchParams;
  const buckets = [
    ...params.getAll("bucket"),
    ...params
      .getAll("buckets")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim()),
  ].filter((value) => value.length > 0);
  const actorParam = params.get("actor");
  let actor: Record<string, unknown> | undefined;
  if (actorParam !== null) {
    try {
      const parsed = JSON.parse(actorParam) as unknown;
      if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error("not an object");
      actor = parsed;
    } catch {
      throw new AuditQueryError("actor must be a JSON object");
    }
  }
  const sinceVersion = auditVersionParam(params, "sinceVersion");
  const untilVersion = auditVersionParam(params, "untilVersion");
  const limitParam = params.get("limit");
  const limit = limitParam === null ? undefined : Number(limitParam);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new AuditQueryError("limit must be a positive integer");
  }
  return {
    ...(buckets.length > 0 ? { buckets: Array.from(new Set(buckets)) } : {}),
    ...(actor ? { actor } : {}),
    ...(sinceVersion ? { sinceVersion } : {}),
    ...(untilVersion ? { untilVersion } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function auditVersionParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AuditQueryError(`${name} must be an unsigned integer`);
  }
  return value;
}

/**
 * Build the Nizhal server: a Hono app exposing /sync/pull, /sync/push, /sync/stream, /nizhal/contract,
 * plus the LISTEN/NOTIFY-free realtime and the durable job worker. Storage/realtime are swappable
 * seams; defaults are Postgres + in-process. RFC §4.5–§4.7.
 *
 * Endpoint wiring (handlePull/handlePush/stream/contract) and the job worker are implemented by
 * codex per WBS C6–C16. The adapter defaults and config surface are established here.
 */
export function createNizhalServer(config: NizhalServerConfig): NizhalServer {
  assertSyncRulesNoLeak(config.syncRules);
  const storage = config.storage ?? postgresStorage({ connectionString: config.db });
  // Audit defaults ON (opt-out via `audit: false`). Throw only when audit is EXPLICITLY
  // requested but the adapter can't support it; default-on degrades gracefully to off for
  // adapters that lack audit support.
  const auditSupported = Boolean(storage.appendAudit && storage.getAuditLog);
  if (config.audit === true && !auditSupported) {
    throw new Error("audit requires storage appendAudit and getAuditLog support");
  }
  const auditEnabled = config.audit !== false && auditSupported;
  const realtime =
    config.realtime ??
    inProcessRealtime({ heartbeatTimeoutMs: config.presence?.heartbeatTimeoutMs });
  const observer = safeObserver(config.observer ?? noopObserver);
  const blob = config.blob;
  const jobTasks = normalizeTasks(config.jobs);
  const jobWorker =
    jobTasks.size > 0
      ? createJobWorker({
          connectionString: config.db,
          tasks: config.jobs ?? {},
          client: storage.getClient?.(),
          closeClientOnStop: storage.getClient ? false : undefined,
        })
      : null;
  const app = new Hono<{
    Variables: { actor: Actor; buckets: BucketKey[]; streamAuthRequest: Request };
  }>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  // CORS must be the first middleware so it wraps every route (and preflight). Off by default;
  // enable for browser clients on a different origin (e.g. an Expo web app hitting the API).
  if (config.cors) {
    app.use("*", cors(config.cors === true ? { origin: "*" } : config.cors));
  }
  const limits = normalizeLimits(config.limits);
  const rateLimiter = createRateLimiter(limits.rateLimit);
  const contract = emitNizhalContract({
    schema: config.schema,
    mutators: config.mutators,
    syncRules: config.syncRules,
  });
  const serverHlc = createHlcClock({ nodeId: crypto.randomUUID() });
  const mergePolicies = collectMergePolicies(config.schema);

  app.onError((error, c) => c.json({ error: error.message }, 500));
  app.get("/nizhal/contract", (c) => c.json(contract));

  app.post("/nizhal/blob/presign-upload", async (c) => {
    const actor = await requireActor(config.auth, c.req.raw);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    if (!blob) return c.json({ error: "blob adapter not configured" }, 501);
    const rawBody = await readBodyText(c.req.raw, limits.maxBodyBytes);
    if (rawBody === BODY_TOO_LARGE) return c.json({ error: "payload too large" }, 413);
    const body = parseJsonBody(rawBody) as {
      mime?: string;
      maxBytes?: number;
      expiresInSec?: number;
      bucket?: string;
      key?: string;
    };
    if (!body.mime) return c.json({ error: "missing mime" }, 400);
    if (body.bucket) {
      const allowed = new Set(await actorBucketKeys(storage, actor, config.syncRules));
      if (!allowed.has(body.bucket)) return c.json({ error: "bucket not allowed" }, 403);
    }
    const key = body.key ?? crypto.randomUUID();
    try {
      const presign = await blob.presignUpload({
        key,
        mime: body.mime,
        maxBytes: body.maxBytes ?? 10 * 1024 * 1024,
        expiresInSec: body.expiresInSec,
      });
      return c.json({
        url: presign.url,
        method: presign.method,
        headers: presign.headers,
        key: presign.key,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observer.onError?.({ phase: "blob", code: message, error });
      throw error;
    }
  });

  app.get("/nizhal/blob/:id/url", async (c) => {
    const actor = await requireActor(config.auth, c.req.raw);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    if (!blob) return c.json({ error: "blob adapter not configured" }, 501);
    const id = c.req.param("id");
    const db = blobDb(storage);
    if (!db) return c.json({ error: "storage client unavailable" }, 500);
    try {
      const ref = await findBlobRef(db, actor, config.syncRules, id);
      if (!ref) return c.json({ error: "not found" }, 404);
      const presign = await blob.presignDownload({ key: id });
      return c.json({ url: presign.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observer.onError?.({ phase: "blob", code: message, error });
      throw error;
    }
  });

  if (isLocalFsBlobStore(blob)) {
    app.put("/nizhal/blob/:key", async (c) => {
      const key = c.req.param("key");
      const url = new URL(c.req.url);
      const token = url.searchParams.get("token") ?? "";
      const expires = url.searchParams.get("expires") ?? "";
      if (!blob.verifyToken(key, token, expires, "PUT")) {
        return c.json({ error: "invalid or expired token" }, 403);
      }
      const body = c.req.raw.body;
      if (!body) return c.json({ error: "missing body" }, 400);
      await blob.write(key, body);
      return c.body(null, 204);
    });

    app.get("/nizhal/blob/:key", async (c) => {
      const key = c.req.param("key");
      const url = new URL(c.req.url);
      const token = url.searchParams.get("token") ?? "";
      const expires = url.searchParams.get("expires") ?? "";
      if (!blob.verifyToken(key, token, expires, "GET")) {
        return c.json({ error: "invalid or expired token" }, 403);
      }
      const bytes = await blob.read(key);
      if (!bytes) return c.json({ error: "not found" }, 404);
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });
  }

  app.get("/nizhal/stats", async (c) => {
    const password = adminPassword();
    if (!password) return c.json({ error: "admin stats not configured" }, 501);
    if (!isAdminAuthorized(c.req.raw, password)) return c.json({ error: "unauthorized" }, 401);
    const db = blobDb(storage);
    if (!db) return c.json({ error: "storage client unavailable" }, 500);
    try {
      const stats = await gatherStats(db, realtime);
      return c.json(stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observer.onError?.({ phase: "job", code: message, error });
      throw error;
    }
  });

  app.get("/nizhal/audit", async (c) => {
    const password = adminPassword();
    if (!password) return c.json({ error: "admin audit access not configured" }, 501);
    if (!isAdminAuthorized(c.req.raw, password)) return c.json({ error: "unauthorized" }, 401);
    if (!auditEnabled || !storage.getAuditLog) {
      return c.json({ error: "audit log not enabled" }, 501);
    }
    try {
      return c.json(await storage.getAuditLog(parseAuditQuery(c.req.raw)));
    } catch (error) {
      if (error instanceof AuditQueryError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.post("/sync/pull", async (c) => {
    const actor = await requireActor(config.auth, c.req.raw);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    const rawBody = await readBodyText(c.req.raw, limits.maxBodyBytes);
    if (rawBody === BODY_TOO_LARGE) return c.json({ error: "payload too large" }, 413);
    if (!rateLimiter.allow(actor)) return c.json({ error: "rate limit exceeded" }, 429);
    const body = parseJsonBody(rawBody) as {
      cursor?: unknown;
      deviceId?: string;
      limit?: number;
    };
    const startedAt = Date.now();
    try {
      const result = await storage.getChanges({
        actor,
        syncRules: config.syncRules,
        cursor: typeof body.cursor === "string" ? body.cursor : INITIAL_CURSOR,
        deviceId: body.deviceId,
        limit: body.limit,
      });
      encodeCrdtColumnsInPullResult(result, mergePolicies);
      observer.onPull?.({
        actor,
        clientId: body.deviceId,
        cursor: result.cursor,
        rows: result.changed.reduce((sum, batch) => sum + batch.rows.length, 0),
        tombstones: result.tombstoned.length,
        durationMs: Date.now() - startedAt,
      });
      const lastMutationId =
        typeof body.deviceId === "string" && body.deviceId.length > 0
          ? await storage.readLastMutationId(body.deviceId)
          : undefined;
      return c.json({
        ...result,
        ...(lastMutationId !== undefined ? { lastMutationId } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observer.onError?.({ phase: "pull", code: message, error });
      throw error;
    }
  });
  app.post("/sync/push", async (c) => {
    const actor = await requireActor(config.auth, c.req.raw);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    const rawBody = await readBodyText(c.req.raw, limits.maxBodyBytes);
    if (rawBody === BODY_TOO_LARGE) return c.json({ error: "payload too large" }, 413);
    if (!rateLimiter.allow(actor)) return c.json({ error: "rate limit exceeded" }, 429);
    const body = parseJsonBody(rawBody) as { mutations?: Mutation[] };
    const mutations = body.mutations ?? [];
    const applied: string[] = [];
    for (const mutation of mutations) {
      const def = config.mutators[mutation.name];
      if (!def) return c.json({ error: `unknown mutator '${mutation.name}'` }, 400);
      let pushed: PushMutationResult;
      const startedAt = Date.now();
      try {
        pushed = await applyMutation({
          storage,
          actor,
          syncRules: config.syncRules,
          mutation,
          def,
          mergePolicies,
          serverHlc,
          observer,
          audit: auditEnabled,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        observer.onError?.({
          phase: "push",
          code: message,
          clientMutationId: mutation.clientMutationId,
          error,
        });
        if (error instanceof OutOfOrderMutationError) {
          const lastMutationId = isSequencedMutation(mutation)
            ? await storage.readLastMutationId(mutation.clientID)
            : undefined;
          return c.json(
            {
              error: error.message,
              ...(lastMutationId !== undefined ? { lastMutationId } : {}),
            },
            409,
          );
        }
        if (error instanceof StoredMutationError) {
          return c.json({ error: error.message }, 422);
        }
        if (error instanceof WriteAuthorizationError) {
          return c.json({ error: error.message }, 403);
        }
        if (isSequencedMutation(mutation) && isDeterministicAppError(error)) {
          await burnSequencedMutation(storage, mutation, message);
          return c.json({ error: message }, 422);
        }
        throw error;
      }
      const { acknowledged, didApply } = pushed;
      observer.onPush?.({
        actor,
        clientId: mutation.clientID,
        mutator: mutation.name,
        clientMutationId: mutation.clientMutationId,
        ok: didApply,
        durationMs: Date.now() - startedAt,
      });
      if (didApply) {
        const mutationBuckets =
          pushed.affectedBuckets ??
          (await affectedBuckets(storage, config.syncRules, actor, pushed.mutatorResult));
        // The mutation has committed. A post-commit realtime publish is best-effort: a transient
        // failure must not fail the (durable) push nor abort the rest of the batch — connected
        // clients reconcile via their next pull. Surface it for observability; never rethrow.
        try {
          for (const bucket of mutationBuckets) {
            await realtime.publish(bucket);
          }
        } catch (error) {
          observer.onError?.({
            phase: "push",
            code: error instanceof Error ? error.message : String(error),
            clientMutationId: mutation.clientMutationId,
            error,
          });
        }
      }
      if (acknowledged) applied.push(mutation.clientMutationId);
    }
    const clientIDs = Array.from(
      new Set(mutations.filter(isSequencedMutation).map((mutation) => mutation.clientID)),
    );
    if (clientIDs.length === 1) {
      return c.json({
        applied,
        lastMutationId: await storage.readLastMutationId(clientIDs[0] as string),
      });
    }
    if (clientIDs.length > 1) {
      const clientSequences = Object.fromEntries(
        await Promise.all(
          clientIDs.map(async (clientID) => [clientID, await storage.readLastMutationId(clientID)]),
        ),
      );
      return c.json({ applied, clientSequences });
    }
    return c.json({ applied });
  });
  app.get("/sync/realtime/authorize", async (c) => {
    const actor = await requireActor(config.auth, requestWithStreamAuth(c.req.raw));
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    const bucket = c.req.query("bucket");
    if (!bucket) return c.json({ error: "missing bucket" }, 400);
    const allowed = await actorBucketKeys(storage, actor, config.syncRules);
    return allowed.includes(bucket)
      ? c.body(null, 204)
      : c.json({ error: "bucket not allowed" }, 403);
  });
  app.get(
    "/sync/stream",
    async (c, next) => {
      const streamAuthRequest = requestWithStreamAuth(c.req.raw);
      const actor = await requireActor(config.auth, streamAuthRequest);
      if (!actor) return c.json({ error: "unauthorized" }, 401);
      const allowed = await actorBucketKeys(storage, actor, config.syncRules);
      const requested = requestedStreamBuckets(c.req.raw);
      if (requested.some((bucket) => !allowed.includes(bucket))) {
        return c.json({ error: "bucket not allowed" }, 403);
      }
      c.set("actor", actor);
      c.set("buckets", requested.length > 0 ? requested : allowed);
      c.set("streamAuthRequest", streamAuthRequest);
      await next();
    },
    upgradeWebSocket((c) => {
      const actor = c.get("actor");
      const buckets = c.get("buckets");
      const streamAuthRequest = c.get("streamAuthRequest");
      let unsubscribe = () => {};
      let socketRef: RealtimeSocket | null = null;
      const presenceRefs = new Map<string, string>();

      return {
        onOpen(_event, socket) {
          const authorizedSocket: RealtimeSocket = {
            async send(data) {
              const currentActor = await requireActor(config.auth, streamAuthRequest);
              if (
                !currentActor ||
                currentActor.userId !== actor.userId ||
                currentActor.ownerId !== actor.ownerId
              ) {
                socket.close(1008, "credential expired");
                unsubscribe();
                return;
              }
              const bucket = realtimeFrameBucket(data);
              if (bucket) {
                const allowed = await actorBucketKeys(storage, currentActor, config.syncRules);
                if (!allowed.includes(bucket)) return;
              }
              socket.send(data);
            },
          };
          socketRef = authorizedSocket;
          unsubscribe = realtime.subscribe(buckets, authorizedSocket);
        },
        async onMessage(event) {
          if (!socketRef || !realtime.presence || typeof event.data !== "string") return;
          if (event.data.startsWith("presence:track:")) {
            const body = JSON.parse(event.data.slice("presence:track:".length)) as {
              bucket: string;
              payload?: Record<string, unknown>;
            };
            if (!(await actorMayAccessBucket(storage, actor, config.syncRules, body.bucket)))
              return;
            const presenceRef = realtime.presence.track({
              bucket: body.bucket,
              socket: socketRef,
              userId: actor.userId,
              meta: body.payload ?? {},
            });
            presenceRefs.set(body.bucket, presenceRef);
            return;
          }
          if (event.data.startsWith("presence:untrack:")) {
            const body = JSON.parse(event.data.slice("presence:untrack:".length)) as {
              bucket: string;
            };
            const presenceRef = presenceRefs.get(body.bucket);
            if (!presenceRef) return;
            realtime.presence.untrack({ bucket: body.bucket, socket: socketRef, presenceRef });
            presenceRefs.delete(body.bucket);
            return;
          }
          if (event.data.startsWith("presence:heartbeat:")) {
            const body = JSON.parse(event.data.slice("presence:heartbeat:".length)) as {
              bucket: string;
            };
            const presenceRef = presenceRefs.get(body.bucket);
            if (!presenceRef) return;
            realtime.presence.heartbeat({
              bucket: body.bucket,
              socket: socketRef,
              presenceRef,
            });
          }
        },
        onClose() {
          if (socketRef && realtime.presence) {
            realtime.presence.leaveSocket(socketRef, buckets);
          }
          presenceRefs.clear();
          unsubscribe();
        },
        onError() {
          if (socketRef && realtime.presence) {
            realtime.presence.leaveSocket(socketRef, buckets);
          }
          presenceRefs.clear();
          unsubscribe();
        },
      };
    }),
  );
  return {
    app,
    listen(port) {
      jobWorker?.start();
      const server = serve({ fetch: app.fetch, port });
      injectWebSocket(server);
      const close = server.close.bind(server);
      server.close = ((callback?: (err?: Error) => void) => {
        const workerStopped = jobWorker?.stop() ?? Promise.resolve();
        return close((error?: Error) => {
          workerStopped.then(
            () => callback?.(error),
            (stopError: unknown) =>
              callback?.(stopError instanceof Error ? stopError : new Error(String(stopError))),
          );
        });
      }) as typeof server.close;
      return server;
    },
  };
}

interface FieldConflict {
  mutator: string;
  table: string;
  rowId: string;
  resolution: "merge";
}

interface PushMutationInput {
  storage: StorageAdapter;
  actor: Actor;
  syncRules: SyncRules;
  mutation: Mutation;
  def: { schema: Schema<unknown>; fn: (ctx: MutatorCtx, args: unknown) => unknown };
  mergePolicies: Map<string, { table: MergeMode; columns: Map<string, MergeMode> }>;
  serverHlc: ReturnType<typeof createHlcClock>;
  observer: ReturnType<typeof safeObserver>;
  audit: boolean;
}

interface PushMutationResult {
  acknowledged: boolean;
  didApply: boolean;
  mutatorResult: unknown;
  affectedBuckets?: BucketKey[];
}

class OutOfOrderMutationError extends Error {}

class StoredMutationError extends Error {}

async function applyMutation(input: PushMutationInput): Promise<PushMutationResult> {
  let mutatorResult: unknown;
  let mutationBuckets: BucketKey[] = [];
  let didApply = false;
  let acknowledged = false;
  const conflicts: FieldConflict[] = [];
  await input.storage.transaction(async (tx) => {
    if (isSequencedMutation(input.mutation)) {
      const sequence = await input.storage.checkMutationSequence?.(tx, input.mutation);
      if (sequence === "outOfOrder") {
        throw new OutOfOrderMutationError(
          `out-of-order mutation ${input.mutation.mutationID} for client ${input.mutation.clientID}`,
        );
      }
      if (sequence === "alreadyApplied") {
        const storedError = await input.storage.appliedMutationError?.(
          input.mutation.clientMutationId,
          tx,
        );
        if (storedError) throw new StoredMutationError(storedError);
        acknowledged = await input.storage.isApplied(input.mutation.clientMutationId, tx);
        return;
      }
      if (input.mutation.hlc) input.serverHlc.recv(input.mutation.hlc);
    }
    const claimed = await input.storage.claimMutation(tx, input.mutation.clientMutationId);
    if (!claimed) {
      const storedError = await input.storage.appliedMutationError?.(
        input.mutation.clientMutationId,
        tx,
      );
      if (storedError) throw new StoredMutationError(storedError);
      acknowledged = true;
      return;
    }
    const args = input.def.schema.parse(input.mutation.args);
    const mutationHlc = input.mutation.hlc ?? input.serverHlc.send();
    const ctx = await createMutatorCtx(
      input.storage,
      tx,
      input.actor,
      input.syncRules,
      input.mergePolicies,
      mutationHlc,
      input.mutation.name,
      conflicts,
    );
    mutatorResult = await input.def.fn(ctx, args);
    await ctx.jobs.flush();
    await input.storage.recordApplied(
      input.mutation.clientMutationId,
      reconciliationMap(args, mutatorResult),
      tx,
    );
    if (input.audit) {
      mutationBuckets = await affectedBuckets(
        input.storage,
        input.syncRules,
        input.actor,
        mutatorResult,
        tx,
      );
      const appendAudit = input.storage.appendAudit;
      if (!appendAudit) throw new Error("audit append is unavailable");
      await appendAudit(tx, {
        clientMutationId: input.mutation.clientMutationId,
        mutationName: input.mutation.name,
        args: input.mutation.args ?? null,
        actor: { ...input.actor },
        clientId: input.mutation.clientID ?? null,
        mutationId: input.mutation.mutationID ?? null,
        hlc: mutationHlc,
        affectedBuckets: mutationBuckets,
      });
    }
    didApply = true;
    acknowledged = true;
  });
  for (const conflict of conflicts) {
    input.observer.onConflict?.(conflict);
  }
  return {
    acknowledged,
    didApply,
    mutatorResult,
    ...(input.audit ? { affectedBuckets: mutationBuckets } : {}),
  };
}

async function burnSequencedMutation(
  storage: StorageAdapter,
  mutation: Mutation & { clientID: string; mutationID: number },
  error: string,
): Promise<void> {
  await storage.transaction(async (tx) => {
    const sequence = await storage.checkMutationSequence?.(tx, mutation);
    if (sequence === "outOfOrder") throw new OutOfOrderMutationError(error);
    await storage.recordApplied(mutation.clientMutationId, { error }, tx);
  });
}

function isSequencedMutation(
  mutation: Mutation,
): mutation is Mutation & { clientID: string; mutationID: number } {
  return (
    typeof mutation.clientID === "string" &&
    mutation.clientID.length > 0 &&
    typeof mutation.mutationID === "number" &&
    Number.isInteger(mutation.mutationID) &&
    mutation.mutationID > 0
  );
}

function isDeterministicAppError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const maybeDbError = error as Error & {
    code?: unknown;
    severity?: unknown;
    constraint_name?: unknown;
    table?: unknown;
  };
  return (
    maybeDbError.code === undefined &&
    maybeDbError.severity === undefined &&
    maybeDbError.constraint_name === undefined &&
    maybeDbError.table === undefined
  );
}

export * from "./adapters/index.js";
export * from "./auth.js";
export * from "./jobs.js";
export type { NizhalDb } from "./drizzle-db.js";

function normalizeLimits(config: NizhalServerConfig["limits"] | undefined): {
  maxBodyBytes: number;
  rateLimit: false | { windowMs: number; maxRequests: number };
} {
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    rateLimit:
      config?.rateLimit === false
        ? false
        : {
            windowMs: config?.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
            maxRequests: config?.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
          },
  };
}

function createRateLimiter(limit: false | { windowMs: number; maxRequests: number }): {
  allow(actor: Actor): boolean;
} {
  if (limit === false) return { allow: () => true };
  const windows = new Map<string, { resetAt: number; count: number }>();
  return {
    allow(actor) {
      const now = Date.now();
      const key = `${actor.ownerId}:${actor.userId}`;
      const current = windows.get(key);
      if (!current || current.resetAt <= now) {
        windows.set(key, { resetAt: now + limit.windowMs, count: 1 });
        return true;
      }
      if (current.count >= limit.maxRequests) return false;
      current.count += 1;
      return true;
    },
  };
}

async function readBodyText(
  req: Request,
  maxBytes: number,
): Promise<string | typeof BODY_TOO_LARGE> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) return BODY_TOO_LARGE;
  }
  if (!req.body) return "";

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return BODY_TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseJsonBody(rawBody: string): unknown {
  if (rawBody.trim() === "") return {};
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return {};
  }
}

async function requireActor(auth: NizhalAuth, req: Request): Promise<Actor | null> {
  const actor = await auth.resolve(req);
  return actor ? { ...actor } : null;
}

function requestWithStreamAuth(req: Request): Request {
  if (req.headers.has("authorization")) return req;
  const url = new URL(req.url);
  const authorization = url.searchParams.get("authorization");
  const token = url.searchParams.get("token");
  const header = authorization ?? tokenAuthorization(token);
  if (!header) return req;
  const headers = new Headers(req.headers);
  headers.set("authorization", header);
  return new Request(req, { headers });
}

function tokenAuthorization(token: string | null): string | null {
  if (!token) return null;
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function requestedStreamBuckets(req: Request): BucketKey[] {
  const buckets = new URL(req.url).searchParams
    .getAll("bucket")
    .filter((value) => value.length > 0);
  return Array.from(new Set(buckets));
}

function realtimeFrameBucket(data: string): string | undefined {
  if (data.startsWith("repull:")) return data.slice("repull:".length);
  if (data.startsWith("presence:state:")) {
    return frameBucket(data.slice("presence:state:".length));
  }
  if (data.startsWith("presence:diff:")) {
    return frameBucket(data.slice("presence:diff:".length));
  }
  return undefined;
}

function frameBucket(json: string): string | undefined {
  try {
    const value = JSON.parse(json) as unknown;
    return isRecord(value) && typeof value.bucket === "string" ? value.bucket : undefined;
  } catch {
    return undefined;
  }
}

async function actorMayAccessBucket(
  storage: StorageAdapter,
  actor: Actor,
  syncRules: SyncRules,
  bucket: string,
): Promise<boolean> {
  return (await actorBucketKeys(storage, actor, syncRules)).includes(bucket);
}

async function createMutatorCtx(
  storage: StorageAdapter,
  tx: StorageTx,
  actor: Actor,
  syncRules: SyncRules,
  mergePolicies: Map<string, { table: MergeMode; columns: Map<string, MergeMode> }> = new Map(),
  mutationHlc?: string,
  mutatorName = "",
  conflicts?: FieldConflict[],
): Promise<MutatorCtx & { jobs: BufferedJobScheduler; conflicts: FieldConflict[] }> {
  const conflictList = conflicts ?? [];
  const mergeTx = mergeAwareTx(tx, mergePolicies, mutationHlc, mutatorName, conflictList);
  const authorizedTx = await storage.authorizeMutatorTx({
    tx,
    mutatorTx: mergeTx,
    actor,
    syncRules,
  });
  return {
    tx: authorizedTx,
    location: "server",
    actor,
    ownerId: actor.ownerId,
    userId: actor.userId,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    jobs: createJobScheduler(tx),
    conflicts: conflictList,
    nextInBucket: async ({ table, sequenceColumn, scopeColumn, scopeValue }) => {
      // Serialize per (table, sequenceColumn, scope) within this transaction so two concurrent
      // applies can't both read the same max and assign a colliding value.
      const lockKey = `nizhal:nextInBucket:${table}:${sequenceColumn}:${scopeColumn}:${String(scopeValue)}`;
      await executeRows(tx.db, sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const rows = await executeRows<{ next: number }>(
        tx.db,
        sql`select coalesce(max(${sql.identifier(sequenceColumn)}), 0) + 1 as next
            from ${sql.identifier(table)}
            where ${sql.identifier(scopeColumn)} = ${scopeValue}`,
      );
      return Number(rows[0]?.next ?? 1);
    },
  };
}

function collectMergePolicies(
  schema: Record<string, ContractSchemaSource>,
): Map<string, { table: MergeMode; columns: Map<string, MergeMode> }> {
  const policies = new Map<string, { table: MergeMode; columns: Map<string, MergeMode> }>();
  for (const [fallbackName, source] of Object.entries(schema)) {
    const tableName = schemaTableName(source, fallbackName);
    const table = isNizhalTable(source)
      ? source
      : isNizhalTableSource(source)
        ? source.table
        : undefined;
    const columns = new Map<string, MergeMode>();
    if (isNizhalTable(table)) {
      for (const [columnName, mode] of tableColumnMergeModes(table)) {
        columns.set(columnName, mode);
      }
    }
    policies.set(tableName, { table: schemaMergeMode(source), columns });
  }
  return policies;
}

function mergeAwareTx(
  tx: StorageTx,
  mergePolicies: Map<string, { table: MergeMode; columns: Map<string, MergeMode> }>,
  mutationHlc: string | undefined,
  mutatorName: string,
  conflicts: FieldConflict[],
): MutatorTx {
  if (!mutationHlc) return tx;
  return {
    insert(table) {
      return tx.insert(table);
    },
    update(table, where) {
      const tableName = getTableName(table);
      const policy = mergePolicies.get(tableName) ?? { table: "lww", columns: new Map() };
      const predicate = whereToPredicate(table, where);
      return {
        async set(patch) {
          const columns = getTableColumns(table as PgTable) as Record<string, { name: string }>;
          const crdtPatch: Record<string, unknown> = {};
          const scalarPatch: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(patch)) {
            if (value === undefined || field === "updated_at" || field === "deleted_at") {
              continue;
            }
            const columnName = columns[field]?.name;
            if (columnName && policy.columns.get(columnName) === "crdt") {
              crdtPatch[field] = value;
            } else {
              scalarPatch[field] = value;
            }
          }
          const results: Record<string, unknown>[][] = [];
          if (Object.keys(crdtPatch).length > 0) {
            results.push(await crdtMergeUpdate(tx, table, crdtPatch, predicate));
          }
          if (Object.keys(scalarPatch).length > 0) {
            if (policy.table === "field") {
              results.push(
                await fieldMergeUpdate(
                  tx,
                  table,
                  scalarPatch,
                  predicate,
                  mutationHlc,
                  mutatorName,
                  conflicts,
                ),
              );
            } else {
              results.push(
                (await tx.update(table, where).set(scalarPatch)) as Record<string, unknown>[],
              );
            }
          }
          return results.flat();
        },
      };
    },
    delete(table, where) {
      return tx.delete(table, where);
    },
  };
}

async function crdtMergeUpdate<TTable extends Table>(
  tx: StorageTx,
  table: TTable,
  patch: Record<string, unknown>,
  predicate: MutatorPredicate<TTable>,
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName(table);
  const columns = getTableColumns(table as PgTable) as Record<string, { name: string }>;
  const where = resolvePredicate(table, predicate);
  const targets = await executeRows<{ id: unknown; _nizhal_row_version: unknown }>(
    tx.db,
    sql`select id, _nizhal_row_version from ${sql.identifier(tableName)} where ${where} for update`,
  );
  const merged: Record<string, unknown>[] = [];
  for (const target of targets) {
    const row = await mergeCrdtRow(
      tx.db,
      tableName,
      columns,
      target.id,
      target._nizhal_row_version,
      patch,
    );
    if (row) merged.push(row);
  }
  return merged;
}

const MAX_CRDT_MERGE_ATTEMPTS = 5;

async function mergeCrdtRow(
  db: NizhalDb,
  tableName: string,
  columns: Record<string, { name: string }>,
  id: unknown,
  expectedVersion: unknown,
  patch: Record<string, unknown>,
  attempt = 0,
): Promise<Record<string, unknown> | undefined> {
  const rows = await executeRows<Record<string, unknown>>(
    db,
    sql`select * from ${sql.identifier(tableName)} where ${sql.identifier("id")} = ${id}`,
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (!row) return undefined;

  const assignments: SQL[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const columnName = columns[field]?.name;
    if (!columnName) continue;
    const current = asUint8Array(row[columnName]);
    const incoming = asUint8Array(value);
    const doc = new Y.Doc();
    if (current) Y.applyUpdate(doc, current);
    if (incoming) Y.applyUpdate(doc, incoming);
    const mergedBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
    assignments.push(sql`${sql.identifier(columnName)} = ${mergedBytes}`);
  }
  if (assignments.length === 0) return undefined;

  const updated = await executeRows<Record<string, unknown>>(
    db,
    sql`update ${sql.identifier(tableName)}
      set ${sql.join(assignments, sql`, `)}
      where ${sql.identifier("id")} = ${id} and ${sql.identifier("_nizhal_row_version")} = ${expectedVersion}
      returning *`,
  );
  if (updated.length > 0) return updated[0];
  if (attempt >= MAX_CRDT_MERGE_ATTEMPTS) return undefined;
  return mergeCrdtRow(db, tableName, columns, id, row._nizhal_row_version, patch, attempt + 1);
}

function asUint8Array(value: unknown): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === "string") {
    try {
      return Buffer.from(value, "base64");
    } catch {
      return undefined;
    }
  }
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return undefined;
}

function encodeCrdtColumnsInPullResult(
  result: PullResult,
  mergePolicies: Map<string, { table: MergeMode; columns: Map<string, MergeMode> }>,
): void {
  for (const batch of result.changed) {
    const policy = mergePolicies.get(batch.table);
    if (!policy) continue;
    const crdtColumns = Array.from(policy.columns.entries())
      .filter(([, mode]) => mode === "crdt")
      .map(([name]) => name);
    if (crdtColumns.length === 0) continue;
    for (const row of batch.rows) {
      for (const column of crdtColumns) {
        const value = (row as Record<string, unknown>)[column];
        if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
          (row as Record<string, unknown>)[column] = Buffer.from(value).toString("base64");
        }
      }
    }
  }
}

async function fieldMergeUpdate<TTable extends Table>(
  tx: StorageTx,
  table: TTable,
  patch: Partial<TTable["$inferInsert"]>,
  predicate: MutatorPredicate<TTable>,
  hlc: string,
  mutatorName: string,
  conflicts: FieldConflict[],
): Promise<Record<string, unknown>[]> {
  const columns = getTableColumns(table as PgTable) as Record<string, { name: string }>;
  const assignments: SQL[] = [];
  const winConditions: SQL[] = [];
  let metaExpression: SQL = sql`coalesce(${sql.identifier("_meta")}, '{}'::jsonb)`;
  const patchFields: { field: string; value: unknown; columnName: string }[] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined || field === "updated_at" || field === "deleted_at") continue;
    const columnName = columns[field]?.name;
    if (!columnName || columnName === "_meta") continue;
    const winCondition = sql`coalesce(${sql.identifier("_meta")} ->> ${columnName}, '') < ${hlc}`;
    winConditions.push(winCondition);
    assignments.push(
      sql`${sql.identifier(columnName)} = case when ${winCondition} then ${value} else ${sql.identifier(columnName)} end`,
    );
    metaExpression = sql`case when ${winCondition} then jsonb_set(${metaExpression}, array[${columnName}], to_jsonb(${hlc}::text), true) else ${metaExpression} end`;
    patchFields.push({ field, value, columnName });
  }

  if (assignments.length === 0) return [];
  assignments.push(sql`${sql.identifier("_meta")} = ${metaExpression}`);
  const where = and(
    resolvePredicate(table, predicate),
    sql`(${sql.join(winConditions, sql` or `)})`,
  );
  const rows = await executeRows<Record<string, unknown>>(
    tx.db,
    sql`update ${sql.identifier(getTableName(table))}
set ${sql.join(assignments, sql`, `)}
where ${where}
returning *`,
  );

  const tableName = getTableName(table);
  if (rows.length > 0) {
    const rowId = extractIdFromPredicate(predicate) ?? String(rows[0]?.id ?? "unknown");
    conflicts.push({ mutator: mutatorName, table: tableName, rowId, resolution: "merge" });
  }

  return rows;
}

function resolvePredicate<TTable extends Table>(
  table: TTable,
  predicate: MutatorPredicate<TTable>,
): SQL {
  return typeof predicate === "function" ? predicate(table) : predicate;
}

function extractIdFromPredicate<TTable extends Table>(
  predicate: MutatorPredicate<TTable>,
): string | undefined {
  const resolved = typeof predicate === "function" ? undefined : predicate;
  if (!resolved) return undefined;
  const chunks = (resolved as unknown as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  const idColumn = chunks.find(
    (chunk): chunk is { name: string } =>
      typeof chunk === "object" &&
      chunk !== null &&
      "name" in chunk &&
      (chunk as { name?: unknown }).name === "id",
  );
  if (!idColumn) return undefined;
  const param = chunks.find(
    (chunk): chunk is { value: unknown } =>
      typeof chunk === "object" && chunk !== null && "value" in chunk,
  );
  const value = param?.value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function reconciliationMap(
  args: unknown,
  result: unknown,
): { clientId: string; serverId: string } | undefined {
  const clientId = idValue(args, "clientId");
  const serverId = idValue(result, "serverId") ?? idValue(result, "id") ?? scalarIdValue(result);
  if (!clientId || !serverId) return undefined;
  return { clientId, serverId };
}

async function affectedBuckets(
  storage: StorageAdapter,
  syncRules: SyncRules,
  actor: Actor,
  result: unknown,
  tx?: StorageTx,
): Promise<BucketKey[]> {
  const allowed = new Set(await actorBucketKeys(storage, actor, syncRules, tx));
  const explicit = explicitAffectedBuckets(result);
  if (explicit.length > 0) return explicit.filter((bucket) => allowed.has(bucket));
  return Array.from(allowed);
}

async function actorBucketKeys(
  storage: StorageAdapter,
  actor: Actor,
  syncRules: SyncRules,
  tx?: StorageTx,
): Promise<BucketKey[]> {
  if (storage.getActorBuckets) return storage.getActorBuckets({ actor, syncRules, tx });
  return localActorBucketKeys(actor, syncRules);
}

function localActorBucketKeys(actor: Actor, syncRules: SyncRules): BucketKey[] {
  const buckets = new Set<BucketKey>();
  for (const rule of Object.values(syncRules)) {
    const parameters = rule.parameters(actor);
    const bucketColumns = getBucketColumns(parameters);
    if (!bucketColumns) continue;
    for (const [bucketKey, column] of Object.entries(bucketColumns)) {
      const value = actorValue(actor, bucketKey, column);
      if (value !== undefined && value !== null) buckets.add(String(value));
    }
  }
  return Array.from(buckets);
}

function explicitAffectedBuckets(result: unknown): BucketKey[] {
  if (!isRecord(result)) return [];
  const affected = result.affectedBuckets;
  if (Array.isArray(affected)) {
    return affected
      .filter((value): value is string | number | bigint =>
        ["string", "number", "bigint"].includes(typeof value),
      )
      .map(String);
  }
  const bucketKey = result.bucketKey;
  return scalarIdValue(bucketKey) ? [String(bucketKey)] : [];
}

function getBucketColumns(value: unknown): Record<string, string> | null {
  if (!isRecord(value) || !isRecord(value.bucketColumns)) return null;
  const columns: Record<string, string> = {};
  for (const [key, column] of Object.entries(value.bucketColumns)) {
    if (typeof column === "string") columns[key] = column;
  }
  return columns;
}

function actorValue(actor: Actor, bucketKey: string, column: string): unknown {
  if (bucketKey in actor) return actor[bucketKey];
  const camelColumn = column.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (camelColumn in actor) return actor[camelColumn];
  if (column in actor) return actor[column];
  return undefined;
}

function idValue(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  return scalarIdValue(source[key]);
}

function scalarIdValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLocalFsBlobStore(blob: BlobAdapter | undefined): blob is LocalFsBlobStore {
  return (
    blob !== undefined &&
    typeof (blob as LocalFsBlobStore).verifyToken === "function" &&
    typeof (blob as LocalFsBlobStore).read === "function" &&
    typeof (blob as LocalFsBlobStore).write === "function"
  );
}
