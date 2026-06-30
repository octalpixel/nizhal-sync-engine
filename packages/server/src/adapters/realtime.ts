import { type BucketKey, type SyncRules, collectSyncRuleTables } from "@nizhal/kernel";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  type DrizzleClient,
  type PgliteClient,
  type PostgresClient,
  closeRawClient,
  toNizhalDb,
} from "../drizzle-db.js";

export interface PresenceMember {
  userId: string;
  displayName?: string;
}

export type PresenceMeta = Record<string, unknown> & { presence_ref: string };
export type PresenceState = Record<string, PresenceMeta[]>;

export interface PresenceDiff {
  joins: PresenceState;
  leaves: PresenceState;
}

export interface RealtimeSocket {
  send(data: string): void | Promise<void>;
}

export interface PresenceV2Adapter {
  sendState(bucket: BucketKey, socket: RealtimeSocket): void;
  track(input: {
    bucket: BucketKey;
    socket: RealtimeSocket;
    userId: string;
    meta?: Record<string, unknown>;
  }): string;
  untrack(input: { bucket: BucketKey; socket: RealtimeSocket; presenceRef: string }): void;
  heartbeat(input: { bucket: BucketKey; socket: RealtimeSocket; presenceRef: string }): void;
  leaveSocket(socket: RealtimeSocket, buckets: BucketKey[]): void;
}

export interface PresenceV2Options {
  heartbeatTimeoutMs?: number;
}

/**
 * Two methods. `publish` is called ONLY from the commit chokepoint (handlePush). RFC §4.6.
 * `publish` may be async (e.g. Cloudflare Durable Object RPC).
 */
export interface RealtimeStats {
  activeSubscriptions: number;
}

export interface RealtimeAdapter {
  publish(bucket: BucketKey): void | Promise<void>;
  subscribe(buckets: BucketKey[], socket: RealtimeSocket): () => void;
  /**
   * Optional presence v2 tracking. Sends `presence:state` on join and `presence:diff` on changes.
   */
  presence?: PresenceV2Adapter;
  provision?(input: { schema: unknown; syncRules: SyncRules }): Promise<void>;
  stop?(): Promise<void>;
  stats?(): RealtimeStats;
}

const DEFAULT_PRESENCE_HEARTBEAT_TIMEOUT_MS = 30_000;
const PRESENCE_SWEEP_INTERVAL_MS = 5_000;

interface TrackedPresence {
  presenceRef: string;
  userId: string;
  socket: RealtimeSocket;
  meta: Record<string, unknown>;
  lastHeartbeat: number;
}

export function inProcessRealtime(presenceOptions?: PresenceV2Options): RealtimeAdapter {
  const registry = new Map<BucketKey, Set<RealtimeSocket>>();
  const presenceByBucket = new Map<BucketKey, Map<string, TrackedPresence>>();
  const heartbeatTimeoutMs =
    presenceOptions?.heartbeatTimeoutMs ?? DEFAULT_PRESENCE_HEARTBEAT_TIMEOUT_MS;
  const sweepIntervalMs = Math.min(
    PRESENCE_SWEEP_INTERVAL_MS,
    Math.max(100, Math.floor(heartbeatTimeoutMs / 2)),
  );

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [bucket, entries] of presenceByBucket) {
      const expired: TrackedPresence[] = [];
      for (const entry of entries.values()) {
        if (now - entry.lastHeartbeat > heartbeatTimeoutMs) expired.push(entry);
      }
      for (const entry of expired) {
        entries.delete(entry.presenceRef);
        broadcastDiff(bucket, { joins: {}, leaves: leaveState(entry) });
      }
    }
  }, sweepIntervalMs);
  if (typeof sweepTimer === "object" && "unref" in sweepTimer) sweepTimer.unref();

  function bucketEntries(bucket: BucketKey): Map<string, TrackedPresence> {
    let entries = presenceByBucket.get(bucket);
    if (!entries) {
      entries = new Map();
      presenceByBucket.set(bucket, entries);
    }
    return entries;
  }

  function buildState(bucket: BucketKey): PresenceState {
    const state: PresenceState = {};
    const entries = presenceByBucket.get(bucket);
    if (!entries) return state;
    for (const entry of entries.values()) {
      const key = entry.userId;
      const meta: PresenceMeta = { presence_ref: entry.presenceRef, ...entry.meta };
      const list = state[key];
      if (list) list.push(meta);
      else state[key] = [meta];
    }
    return state;
  }

  function joinState(entry: TrackedPresence): PresenceState {
    const meta: PresenceMeta = { presence_ref: entry.presenceRef, ...entry.meta };
    return { [entry.userId]: [meta] };
  }

  function leaveState(entry: TrackedPresence): PresenceState {
    const meta: PresenceMeta = { presence_ref: entry.presenceRef, ...entry.meta };
    return { [entry.userId]: [meta] };
  }

  function sendState(socket: RealtimeSocket, bucket: BucketKey) {
    socket.send(`presence:state:${JSON.stringify({ bucket, state: buildState(bucket) })}`);
  }

  function broadcastDiff(bucket: BucketKey, diff: PresenceDiff) {
    if (Object.keys(diff.joins).length === 0 && Object.keys(diff.leaves).length === 0) return;
    const frame = `presence:diff:${JSON.stringify({ bucket, joins: diff.joins, leaves: diff.leaves })}`;
    const subs = registry.get(bucket);
    if (!subs) return;
    for (const socket of subs) socket.send(frame);
  }

  const presence: PresenceV2Adapter = {
    sendState(bucket, socket) {
      sendState(socket, bucket);
    },
    track({ bucket, socket, userId, meta = {} }) {
      const presenceRef = crypto.randomUUID();
      const entry: TrackedPresence = {
        presenceRef,
        userId,
        socket,
        meta,
        lastHeartbeat: Date.now(),
      };
      bucketEntries(bucket).set(presenceRef, entry);
      broadcastDiff(bucket, { joins: joinState(entry), leaves: {} });
      return presenceRef;
    },
    untrack({ bucket, presenceRef }) {
      const entries = presenceByBucket.get(bucket);
      const entry = entries?.get(presenceRef);
      if (!entry) return;
      entries?.delete(presenceRef);
      broadcastDiff(bucket, { joins: {}, leaves: leaveState(entry) });
    },
    heartbeat({ bucket, presenceRef }) {
      const entry = presenceByBucket.get(bucket)?.get(presenceRef);
      if (!entry) return;
      entry.lastHeartbeat = Date.now();
    },
    leaveSocket(socket, buckets) {
      for (const bucket of buckets) {
        const entries = presenceByBucket.get(bucket);
        if (!entries) continue;
        const removed: TrackedPresence[] = [];
        for (const entry of entries.values()) {
          if (entry.socket === socket) removed.push(entry);
        }
        for (const entry of removed) {
          entries.delete(entry.presenceRef);
          broadcastDiff(bucket, { joins: {}, leaves: leaveState(entry) });
        }
      }
    },
  };

  return {
    async publish(bucket) {
      const subs = registry.get(bucket);
      if (!subs) return;
      await Promise.all(Array.from(subs, (socket) => socket.send(`repull:${bucket}`)));
    },
    stats() {
      let total = 0;
      for (const subs of registry.values()) total += subs.size;
      return { activeSubscriptions: total };
    },
    subscribe(buckets, socket) {
      for (const bucket of buckets) {
        let set = registry.get(bucket);
        if (!set) {
          set = new Set();
          registry.set(bucket, set);
        }
        set.add(socket);
        sendState(socket, bucket);
      }
      return () => {
        for (const bucket of buckets) {
          registry.get(bucket)?.delete(socket);
          presence.leaveSocket(socket, [bucket]);
        }
      };
    },
    presence,
  };
}

export function listenNotifyRealtime(opts: ListenNotifyRealtimeOptions): RealtimeAdapter {
  const local = inProcessRealtime();
  const client = opts.client ?? postgres(opts.connectionString);
  const { db } = toNizhalDb(client);
  let listening = false;

  async function ensureListening() {
    if (listening || !isPostgresClient(client)) return;
    listening = true;
    try {
      await client.listen("echo_bucket", (bucket) => {
        local.publish(bucket);
      });
    } catch (error) {
      listening = false;
      throw error;
    }
  }

  return {
    publish(bucket) {
      local.publish(bucket);
    },
    subscribe(buckets, socket) {
      void ensureListening();
      return local.subscribe(buckets, socket);
    },
    stats() {
      return local.stats?.() ?? { activeSubscriptions: 0 };
    },
    presence: local.presence,
    async provision(input) {
      const plan = buildListenNotifyProvisionPlan(input);
      for (const statement of plan.statements) await db.execute(sql.raw(statement));
    },
    async stop() {
      await closeRawClient(client);
    },
  };
}

export interface ListenNotifyRealtimeOptions {
  connectionString: string;
  client?: PostgresClient | PgliteClient | DrizzleClient;
}

export function buildListenNotifyProvisionPlan(input: {
  schema: unknown;
  syncRules: SyncRules;
}): { statements: string[] } {
  void input.schema;
  const tablePlans = Array.from(collectSyncRuleTables(input.syncRules).values()).map((table) => ({
    table: table.table,
    bucketColumns: Array.from(table.bucketColumns).sort(),
  }));
  return { statements: tablePlans.flatMap(notifyTableStatements) };
}

function notifyTableStatements(table: { table: string; bucketColumns: string[] }): string[] {
  return table.bucketColumns.flatMap((bucketColumn) =>
    notifyBucketStatements(table.table, bucketColumn),
  );
}

function notifyBucketStatements(table: string, bucketColumn: string): string[] {
  const tableName = quoteIdentifier(table);
  const columnName = quoteIdentifier(bucketColumn);
  const notifyFunction = quoteIdentifier(`_nizhal_notify_${table}_${bucketColumn}`);
  const notifyTrigger = quoteIdentifier(`_nizhal_notify_${table}_${bucketColumn}_trg`);
  return [
    `create or replace function ${notifyFunction}()
returns trigger
language plpgsql
as $$
declare
  bucket text;
  control_suppressed boolean;
begin
  bucket := coalesce(new.${columnName}, old.${columnName})::text;
  select suppress_notify into control_suppressed from _nizhal_sync_control where id = true;
  if bucket is not null and coalesce(control_suppressed, false) = false and current_setting('echo.suppress_notify', true) is distinct from 'on' then
    perform pg_notify('echo_bucket', bucket);
  end if;
  return coalesce(new, old);
end;
$$`,
    `drop trigger if exists ${notifyTrigger} on ${tableName}`,
    `create trigger ${notifyTrigger}
after insert or update or delete on ${tableName}
for each row
execute function ${notifyFunction}()`,
  ];
}

function isPostgresClient(
  client: PostgresClient | PgliteClient | DrizzleClient,
): client is PostgresClient {
  return typeof client === "function" && "listen" in client && typeof client.listen === "function";
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid Postgres identifier '${identifier}'`);
  }
  return `"${identifier}"`;
}
