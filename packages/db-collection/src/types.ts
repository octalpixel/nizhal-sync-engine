import type { Mutation, MutatorDef } from "@nizhal/kernel";
import type { NizhalStatusController } from "./status.js";
import type { NizhalSyncTarget } from "./sync-target.js";

export interface NizhalAuthConfig {
  headers?: Record<string, string>;
  /** Called on 401 from pull/push; return fresh auth headers. Retried once. */
  refresh?: () => Promise<Record<string, string>>;
}

export interface PresenceMember {
  userId: string;
  displayName?: string;
}

export type PresenceMeta = Record<string, unknown> & { presence_ref: string };
export type PresenceStateMap = Record<string, PresenceMeta[]>;

export interface PresenceDiff {
  joins: PresenceStateMap;
  leaves: PresenceStateMap;
}

export type PresenceEvent =
  | { event: "sync"; state: PresenceStateMap }
  | { event: "join"; key: string; metas: PresenceMeta[] }
  | { event: "leave"; key: string; metas: PresenceMeta[] };

export interface NizhalReconnectConfig {
  /** Extra random delay before catch-up pull on reconnect; `false` disables for tests. */
  jitterMs?: number | false;
  minReconnectionDelay?: number;
  maxReconnectionDelay?: number;
}

export interface NizhalPullConfig {
  /** Max rows per pull page during bootstrap catch-up. */
  pageSize?: number;
  /** Authoritative fallback pull when realtime pokes are missed (Replicache-style). */
  intervalMs?: number;
}

export interface NizhalTtlConfig {
  /** Evict local rows for buckets out of sync-rule scope after this duration. */
  bucketTtlMs?: number;
}

export interface NizhalPresenceConfig {
  /** Client heartbeat interval while tracking presence (default 15s). */
  heartbeatIntervalMs?: number;
}

export type NizhalMode = "local-first" | "server-authoritative";

export interface NizhalSubscribeSource {
  subscribe(
    buckets: string[],
    onMessage: (data: string) => void,
    onReconnect?: () => void,
  ): () => void;
  /** Optional outbound channel for lightweight frames such as presence heartbeats. */
  send?(data: string): void;
}

export interface NizhalClientConfig {
  server?: string;
  /** Overrides the built-in HTTP transport. Realtime remains configured through subscribeSource. */
  syncTarget?: NizhalSyncTarget;
  /** Local SQLite is authoritative by default; opt into the legacy server-owned base explicitly. */
  mode?: NizhalMode;
  /** Stable per-installation identifier used for device-specific access revocation. */
  deviceId?: string;
  /** When set, resolves the server base URL on each request (for chaos/restart harnesses). */
  getServer?: () => string | undefined;
  auth?: NizhalAuthConfig | unknown;
  /** Test/dev: wire realtime without a live `/sync/stream` endpoint. */
  subscribeSource?: NizhalSubscribeSource;
  /** Buckets to subscribe for each sync rule (test harness supplies actor buckets). */
  bucketsForSyncRule?: (syncRule: string) => string[];
  /** Optional sync-status/outbox controller from `createNizhalStatus`. */
  status?: NizhalStatusController;
  reconnect?: NizhalReconnectConfig;
  pull?: NizhalPullConfig;
  ttl?: NizhalTtlConfig;
  presence?: NizhalPresenceConfig;
}

export type NizhalMutatorDefinition<A = any> = MutatorDef<A> & {
  /** This mutation's own stable domain identity, referenced by a dependent's `dependsOn`. */
  key?: (args: A) => string | undefined;
  /** The domain `key` of a mutation this one depends on; if that mutation is poisoned (terminally
   *  dead-lettered), this one is cascade-cancelled rather than applied against a missing dependency. */
  dependsOn?: (args: A) => string | undefined;
};

export interface NizhalPoisonEntry {
  idempotencyKey: string;
  /** The poisoned mutation's domain `key`, so dependents' `dependsOn` can match it. */
  dependencyKey?: string;
  mutation: Mutation;
  error: Error;
  parkedAt: number;
}

/** Connectivity detector — Nizhal-owned (the previous @tanstack/offline-transactions shape). */
export interface OnlineDetector {
  isOnline(): boolean;
  subscribe(callback: () => void): () => void;
  notifyOnline(): void;
  dispose(): void;
}

/** A durable outbox entry surfaced to status/bootstrap consumers (legacy executor shape kept). */
export interface OutboxTransactionLike {
  id: string;
  idempotencyKey?: string;
  mutationFnName?: string;
  metadata?: Record<string, unknown>;
  mutations?: unknown[];
}

/** Thrown by sync targets to mark a push as terminally non-retriable. */
export class NonRetriableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetriableError";
  }
}
