import { type Cursor, INITIAL_CURSOR, type Mutation, type PullResult } from "@nizhal/kernel";
import type { OfflineTransaction } from "@tanstack/offline-transactions";
import { LocalWriteBarrier, type LocalWriteRow } from "./local-write-barrier.js";
import { mergeBucketPresence, syncPresenceDiff, syncPresenceState } from "./presence-sync.js";
import { type NizhalStatus, type NizhalStatusController, createNizhalStatus } from "./status.js";
import {
  type NizhalAuthState,
  NizhalSyncTargetError,
  createNizhalAuthState,
  httpSyncTargetWithAuthState,
} from "./sync-target.js";
import type {
  NizhalClientConfig,
  NizhalMode,
  NizhalReconnectConfig,
  NizhalSubscribeSource,
  PresenceEvent,
  PresenceMember,
  PresenceStateMap,
} from "./types.js";
import {
  type WebSocketFactory,
  type WebSocketLike,
  createWebSocketSource,
} from "./websocket-source.js";

export interface NizhalClient extends NizhalStatus {
  pull(input: {
    cursor: Cursor;
    syncRule: string;
    limit?: number;
    /** @internal Prevent recursive application when called by a collection sync loop. */
    source?: "sync";
  }): Promise<PullResult>;
  push(mutation: Mutation): Promise<NizhalPushResult>;
  getLastMutationId(): number;
  subscribe(syncRule: string, onHint: () => void): () => void;
  track(syncRule: string, payload?: Record<string, unknown>): void;
  untrack(syncRule: string): void;
  presenceState(syncRule: string): PresenceStateMap;
  onPresence(syncRule: string, handler: (event: PresenceEvent) => void): () => void;
  /** @deprecated Use `onPresence` / `presenceState`. */
  subscribePresence(syncRule: string, onUpdate: (members: PresenceMember[]) => void): () => void;
  /** @deprecated Use `presenceState`. */
  presence(syncRule: string): PresenceMember[];
  getCursor(syncRule: string): Cursor;
  setCursor(syncRule: string, cursor: Cursor): void;
  getScopeBuckets(syncRule: string): string[];
  getPullPageSize(): number | undefined;
  getPullIntervalMs(): number | undefined;
  getBucketTtlMs(): number | undefined;
  setDeviceId(deviceId: string): void;
  reportError(phase: string, error: unknown): void;
  getMode?(): NizhalMode;
  isRemoteSyncEnabled?(): boolean;
  registerCollection?(collectionId: string, syncRule: string, mode: NizhalMode): void;
  isCollectionLocalFirst?(collectionId: string): boolean;
  registerPuller?(collectionId: string, syncRule: string, pull: () => Promise<boolean>): () => void;
  setLocalWriteBootstrap?(bootstrap: Promise<ReadonlyArray<OfflineTransaction>>): void;
  waitForLocalWritesReady?(): Promise<void>;
  registerLocalWrite?(transactionId: string, rows: ReadonlyArray<LocalWriteRow>): void;
  isLocalWriteBlocked?(collectionId: string, key: string): boolean;
  getPendingLocalFields?(collectionId: string, key: string): ReadonlySet<string>;
  acknowledgeLocalWrite?(transactionId: string): Promise<void>;
}

export interface NizhalPushResult {
  lastMutationId?: number;
  accepted?: boolean;
  outOfOrder?: boolean;
}

type HintHandler = () => void;
type PresenceHandler = (event: PresenceEvent) => void;

const DEFAULT_RECONNECT_JITTER_MS = 1_000;
const RECONNECT_NOTIFY_DEBOUNCE_MS = 50;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;

export function createNizhalClient(config: NizhalClientConfig): NizhalClient {
  const resolveServer = () => {
    const configured = config.getServer?.() ?? config.server;
    return configured?.replace(/\/$/, "");
  };
  const server = resolveServer();
  const cursors = new Map<string, Cursor>();
  const handlersByRule = new Map<string, Set<HintHandler>>();
  const activeRules = new Set<string>();
  const presenceRules = new Set<string>();
  const presenceHandlersByRule = new Map<string, Set<PresenceHandler>>();
  const presenceByBucket = new Map<string, PresenceStateMap>();
  const trackedRules = new Map<string, Record<string, unknown>>();
  const collectionModes = new Map<string, NizhalMode>();
  const pullers = new Map<string, { syncRule: string; pull: () => Promise<boolean> }>();
  const localWriteBarrier = new LocalWriteBarrier();
  let streamUnsub: (() => void) | null = null;
  let currentSource: NizhalSubscribeSource | null = null;
  let reconnectNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectPending = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let deviceId = config.deviceId ?? safeRandomUUID();
  let lastMutationId = 0;

  const authState = createNizhalAuthState(config.auth);
  const syncTarget = config.syncTarget ?? httpSyncTargetWithAuthState(resolveServer, authState);
  const bucketResolver = config.bucketsForSyncRule ?? (() => []);
  const subscribeSource =
    config.subscribeSource ??
    (server
      ? createPartySocketSource(server, authState, config.reconnect)
      : noRemoteSubscribeSource());
  const status: NizhalStatusController = config.status ?? createNizhalStatus({});
  const pullPageSize = config.pull?.pageSize;
  const pullIntervalMs = config.pull?.intervalMs;
  const bucketTtlMs = config.ttl?.bucketTtlMs;
  const presenceHeartbeatMs =
    config.presence?.heartbeatIntervalMs ?? PRESENCE_HEARTBEAT_INTERVAL_MS;

  function allBuckets(): string[] {
    const buckets = new Set<string>();
    for (const rule of activeRules) {
      for (const bucket of bucketResolver(rule)) buckets.add(bucket);
    }
    for (const rule of presenceRules) {
      for (const bucket of bucketResolver(rule)) buckets.add(bucket);
    }
    return [...buckets];
  }

  function stateForRule(rule: string): PresenceStateMap {
    return mergeBucketPresence(presenceByBucket, bucketResolver(rule));
  }

  function notifyPresence(rule: string, event: PresenceEvent) {
    const handlers = presenceHandlersByRule.get(rule);
    if (!handlers) return;
    for (const handler of handlers) handler(event);
  }

  function applyBucketState(bucket: string, state: PresenceStateMap) {
    presenceByBucket.set(bucket, state);
    for (const rule of presenceRules) {
      if (!bucketResolver(rule).includes(bucket)) continue;
      notifyPresence(rule, { event: "sync", state: stateForRule(rule) });
    }
  }

  function applyBucketDiff(
    bucket: string,
    diff: { joins: PresenceStateMap; leaves: PresenceStateMap },
  ) {
    const current = presenceByBucket.get(bucket) ?? {};
    const next = syncPresenceDiff(
      current,
      diff,
      (key, metas) => {
        for (const rule of presenceRules) {
          if (!bucketResolver(rule).includes(bucket)) continue;
          notifyPresence(rule, { event: "join", key, metas });
        }
      },
      (key, metas) => {
        for (const rule of presenceRules) {
          if (!bucketResolver(rule).includes(bucket)) continue;
          notifyPresence(rule, { event: "leave", key, metas });
        }
      },
    );
    presenceByBucket.set(bucket, next);
  }

  function sendTrack(rule: string, payload: Record<string, unknown>) {
    for (const bucket of bucketResolver(rule)) {
      currentSource?.send?.(`presence:track:${JSON.stringify({ bucket, payload })}`);
    }
  }

  function sendUntrack(rule: string) {
    for (const bucket of bucketResolver(rule)) {
      currentSource?.send?.(`presence:untrack:${JSON.stringify({ bucket })}`);
    }
  }

  function sendHeartbeats() {
    for (const rule of trackedRules.keys()) {
      for (const bucket of bucketResolver(rule)) {
        currentSource?.send?.(`presence:heartbeat:${JSON.stringify({ bucket })}`);
      }
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer || trackedRules.size === 0) return;
    heartbeatTimer = setInterval(sendHeartbeats, presenceHeartbeatMs);
    if (typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) heartbeatTimer.unref();
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function notifyReconnectHints() {
    for (const handlers of handlersByRule.values()) {
      for (const handler of handlers) handler();
    }
  }

  function scheduleReconnectHints() {
    reconnectPending = true;
    if (reconnectNotifyTimer) return;
    const jitter = reconnectJitterDelay(config.reconnect);
    reconnectNotifyTimer = setTimeout(() => {
      reconnectNotifyTimer = null;
      if (!reconnectPending) return;
      reconnectPending = false;
      notifyReconnectHints();
    }, jitter + RECONNECT_NOTIFY_DEBOUNCE_MS);
  }

  const connectStream = () => {
    if (streamUnsub) {
      streamUnsub();
      streamUnsub = null;
    }
    const buckets = allBuckets();
    currentSource = subscribeSource;
    streamUnsub = subscribeSource.subscribe(
      buckets,
      (message) => {
        if (message.startsWith("repull:")) {
          for (const handlers of handlersByRule.values()) {
            for (const handler of handlers) handler();
          }
          return;
        }
        if (message.startsWith("presence:state:")) {
          const frame = JSON.parse(message.slice("presence:state:".length)) as {
            bucket: string;
            state: PresenceStateMap;
          };
          const current = presenceByBucket.get(frame.bucket) ?? {};
          const next = syncPresenceState(
            current,
            frame.state,
            (key, metas) => {
              for (const rule of presenceRules) {
                if (!bucketResolver(rule).includes(frame.bucket)) continue;
                notifyPresence(rule, { event: "join", key, metas });
              }
            },
            (key, metas) => {
              for (const rule of presenceRules) {
                if (!bucketResolver(rule).includes(frame.bucket)) continue;
                notifyPresence(rule, { event: "leave", key, metas });
              }
            },
          );
          applyBucketState(frame.bucket, next);
          return;
        }
        if (message.startsWith("presence:diff:")) {
          const frame = JSON.parse(message.slice("presence:diff:".length)) as {
            bucket: string;
            joins: PresenceStateMap;
            leaves: PresenceStateMap;
          };
          applyBucketDiff(frame.bucket, { joins: frame.joins, leaves: frame.leaves });
        }
      },
      scheduleReconnectHints,
    );
    for (const [rule, payload] of trackedRules) sendTrack(rule, payload);
    if (trackedRules.size > 0) sendHeartbeats();
  };

  const pullTransport = async (input: {
    cursor: Cursor;
    syncRule: string;
    limit?: number;
  }): Promise<PullResult> => {
    try {
      const limit = input.limit ?? pullPageSize;
      const result = await syncTarget.pull({
        cursor: input.cursor,
        syncRule: input.syncRule,
        buckets: bucketResolver(input.syncRule),
        clientId: deviceId,
        ...(limit !== undefined ? { limit } : {}),
      });
      if (isMutationSequence(result.lastMutationId)) {
        lastMutationId = Math.max(lastMutationId, result.lastMutationId);
      }
      status.setCursor(result.cursor);
      return result;
    } catch (error) {
      status.setError("pull", error);
      throw error;
    }
  };

  return {
    async pull(input) {
      const result = await pullTransport(input);
      if (input.source === "sync") return result;
      const matchingPullers = [...pullers.values()].filter(
        (entry) => entry.syncRule === input.syncRule,
      );
      for (const entry of matchingPullers) {
        if (!(await entry.pull())) {
          throw new Error(`failed to apply pull for sync rule '${input.syncRule}'`);
        }
      }
      return result;
    },

    async push(mutation) {
      try {
        const result = await syncTarget.push(mutation);
        if (isMutationSequence(result.lastMutationId)) {
          lastMutationId = Math.max(lastMutationId, result.lastMutationId);
        }
        if (result.status === "rejected") {
          throw new NizhalSyncTargetError(result.error ?? "sync target rejected mutation", {
            retriable: false,
          });
        }
        return {
          ...(isMutationSequence(result.lastMutationId)
            ? { lastMutationId: result.lastMutationId }
            : {}),
          accepted: result.status !== "staleSequence" && result.status !== "outOfOrder",
          ...(result.status === "outOfOrder" ? { outOfOrder: true } : {}),
        };
      } catch (error) {
        status.setError("push", error);
        throw error;
      }
    },

    getLastMutationId() {
      return lastMutationId;
    },

    subscribe(syncRule, onHint) {
      let handlers = handlersByRule.get(syncRule);
      if (!handlers) {
        handlers = new Set();
        handlersByRule.set(syncRule, handlers);
      }
      const wasEmpty = handlers.size === 0;
      handlers.add(onHint);
      if (wasEmpty) {
        activeRules.add(syncRule);
        connectStream();
      }

      return () => {
        const set = handlersByRule.get(syncRule);
        set?.delete(onHint);
        if (set && set.size === 0) {
          handlersByRule.delete(syncRule);
          activeRules.delete(syncRule);
          connectStream();
        }
      };
    },

    track(syncRule, payload = {}) {
      const wasTracked = trackedRules.has(syncRule);
      trackedRules.set(syncRule, payload);
      const needsStream = !presenceRules.has(syncRule);
      if (needsStream) presenceRules.add(syncRule);
      if (needsStream) connectStream();
      sendTrack(syncRule, payload);
      startHeartbeat();
      if (!wasTracked) {
        notifyPresence(syncRule, { event: "sync", state: stateForRule(syncRule) });
      }
    },

    untrack(syncRule) {
      if (!trackedRules.has(syncRule)) return;
      sendUntrack(syncRule);
      trackedRules.delete(syncRule);
      if (trackedRules.size === 0) stopHeartbeat();
    },

    presenceState(syncRule) {
      return stateForRule(syncRule);
    },

    onPresence(syncRule, handler) {
      let handlers = presenceHandlersByRule.get(syncRule);
      if (!handlers) {
        handlers = new Set();
        presenceHandlersByRule.set(syncRule, handlers);
      }
      const wasEmpty = handlers.size === 0;
      handlers.add(handler);
      if (wasEmpty) {
        presenceRules.add(syncRule);
        connectStream();
      }
      handler({ event: "sync", state: stateForRule(syncRule) });

      return () => {
        const set = presenceHandlersByRule.get(syncRule);
        set?.delete(handler);
        if (set && set.size === 0) {
          presenceHandlersByRule.delete(syncRule);
          if (!trackedRules.has(syncRule)) {
            presenceRules.delete(syncRule);
            connectStream();
          }
        }
      };
    },

    subscribePresence(syncRule, onUpdate) {
      return this.onPresence(syncRule, () => {
        onUpdate(presenceMembersFromState(stateForRule(syncRule)));
      });
    },

    presence(syncRule) {
      return presenceMembersFromState(stateForRule(syncRule));
    },

    getCursor(syncRule) {
      return cursors.get(syncRule) ?? INITIAL_CURSOR;
    },

    setCursor(syncRule, cursor) {
      cursors.set(syncRule, cursor);
    },

    getScopeBuckets(syncRule) {
      return bucketResolver(syncRule);
    },

    getPullPageSize() {
      return pullPageSize;
    },

    getPullIntervalMs() {
      return pullIntervalMs;
    },

    getBucketTtlMs() {
      return bucketTtlMs;
    },

    setDeviceId(value) {
      if (value.length === 0) throw new Error("deviceId must not be empty");
      deviceId = value;
    },

    reportError(phase, error) {
      status.setError(phase, error);
    },

    getMode() {
      return config.mode ?? "local-first";
    },

    isRemoteSyncEnabled() {
      return config.syncTarget !== undefined || resolveServer() !== undefined;
    },

    registerCollection(collectionId, _syncRule, mode) {
      collectionModes.set(collectionId, mode);
    },

    isCollectionLocalFirst(collectionId) {
      return collectionModes.get(collectionId) !== "server-authoritative";
    },

    registerPuller(collectionId, syncRule, pull) {
      const entry = { syncRule, pull };
      pullers.set(collectionId, entry);
      return () => {
        if (pullers.get(collectionId) === entry) pullers.delete(collectionId);
      };
    },

    setLocalWriteBootstrap(bootstrap) {
      localWriteBarrier.setBootstrap(bootstrap);
    },

    waitForLocalWritesReady() {
      return localWriteBarrier.ready();
    },

    registerLocalWrite(transactionId, rows) {
      const localFirstRows = rows.filter(
        (row) => collectionModes.get(row.collectionId) !== "server-authoritative",
      );
      localWriteBarrier.register(transactionId, localFirstRows);
    },

    isLocalWriteBlocked(collectionId, key) {
      return localWriteBarrier.isBlocked(collectionId, key);
    },

    getPendingLocalFields(collectionId, key) {
      return localWriteBarrier.pendingFields(collectionId, key);
    },

    async acknowledgeLocalWrite(transactionId) {
      await localWriteBarrier.ready();
      const rows = localWriteBarrier.beginAcknowledgement(transactionId);
      if (rows.length === 0) return;
      try {
        const collectionIds = [...new Set(rows.map((row) => row.collectionId))];
        for (const collectionId of collectionIds) {
          const puller = pullers.get(collectionId);
          if (!puller) {
            throw new Error(
              `acknowledgement pull unavailable for collection '${collectionId}'; preload it before mutating`,
            );
          }
          if (!(await puller.pull())) {
            throw new Error(`acknowledgement pull failed for collection '${collectionId}'`);
          }
        }
        localWriteBarrier.completeAcknowledgement(transactionId);
      } catch (error) {
        localWriteBarrier.failAcknowledgement(transactionId);
        throw error;
      }
    },

    syncStatus: status.syncStatus,
    onSyncStatus: status.onSyncStatus,
    outbox: status.outbox,
  };
}

function isMutationSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function noRemoteSubscribeSource(): NizhalSubscribeSource {
  return {
    subscribe: () => () => {},
  };
}

/**
 * `crypto.randomUUID()` is absent on Hermes and on web served over plain HTTP (non-secure context),
 * so fall back to a `getRandomValues`-backed v4 UUID. Keeps the client transport-agnostic without
 * pushing a polyfill onto every consumer.
 */
function safeRandomUUID(): string {
  const c = (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/** Default browser/Node transport: the native global `WebSocket` already satisfies {@link WebSocketLike}. */
const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new globalThis.WebSocket(url) as unknown as WebSocketLike;

function reconnectOptions(reconnect?: NizhalReconnectConfig) {
  return {
    minDelayMs: reconnect?.minReconnectionDelay,
    maxDelayMs: reconnect?.maxReconnectionDelay,
  };
}

/**
 * Default realtime source against a Nizhal server's `/sync/stream` (Node, Bun, Vercel, or a CF Worker
 * exposing the same endpoint). One reconnecting WebSocket; auth rides the query string (the native
 * WebSocket can't set upgrade headers) and is re-read on every (re)connect so a refreshed token is
 * never stale. `refresh()` runs on a connect that fails before opening (the upgrade-auth failure mode).
 */
export function createPartySocketSource(
  server: string,
  auth: NizhalAuthState,
  reconnect?: NizhalReconnectConfig,
): NizhalSubscribeSource {
  const wsUrl = `${server.replace(/^http/, "ws")}/sync/stream`;
  return createWebSocketSource({
    getUrl: (buckets) => {
      const params = new URLSearchParams(auth.getHeaders());
      for (const bucket of buckets) params.append("bucket", bucket);
      return params.size > 0 ? `${wsUrl}?${params}` : wsUrl;
    },
    webSocketFactory: defaultWebSocketFactory,
    onConnectFailure: auth.refresh
      ? async () => {
          await auth.refresh?.();
        }
      : undefined,
    reconnect: reconnectOptions(reconnect),
  });
}

/** Convert a partyserver host (with or without scheme) to a `ws(s)://…` base. */
function toWsBase(host: string): string {
  if (/^wss?:\/\//.test(host)) return host.replace(/\/+$/, "");
  if (/^https?:\/\//.test(host)) return host.replace(/^http/, "ws").replace(/\/+$/, "");
  const insecure = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  return `${insecure ? "ws" : "wss"}://${host.replace(/\/+$/, "")}`;
}

/**
 * Realtime source for the Cloudflare adapter: partyserver routes `/parties/<namespace>/<room>` WS
 * upgrades to one Durable Object per bucket. A standard WebSocket connects directly — no partysocket
 * client — opening one reconnecting socket per visible bucket, token on the query (re-resolved each
 * (re)connect via `getToken`).
 */
export function createCloudflareSubscribeSource(
  host: string,
  getToken: () => Promise<string>,
  reconnect?: NizhalReconnectConfig,
  // Inject the transport so React Native can reuse this exact per-bucket /parties routing with the
  // native NitroWebSocket factory (browser/Node default to globalThis.WebSocket).
  webSocketFactory: WebSocketFactory = defaultWebSocketFactory,
): NizhalSubscribeSource {
  const base = toWsBase(host);
  let active: Array<() => void> = [];
  let sources: NizhalSubscribeSource[] = [];

  return {
    subscribe(buckets, onMessage, onReconnect) {
      sources = buckets.map((bucket) =>
        createWebSocketSource({
          getUrl: async () => {
            const token = await getToken();
            return `${base}/parties/nizhal-bucket/${encodeURIComponent(bucket)}?token=${encodeURIComponent(token)}`;
          },
          webSocketFactory,
          reconnect: reconnectOptions(reconnect),
        }),
      );
      active = sources.map((source, i) =>
        source.subscribe([buckets[i] as string], onMessage, onReconnect),
      );
      return () => {
        for (const unsub of active) unsub();
        active = [];
        sources = [];
      };
    },
    send(data) {
      for (const source of sources) source.send?.(data);
    },
  };
}

function reconnectJitterDelay(reconnect?: NizhalReconnectConfig): number {
  const jitter = reconnect?.jitterMs ?? DEFAULT_RECONNECT_JITTER_MS;
  if (jitter === false) return 0;
  return Math.floor(Math.random() * jitter);
}

function presenceMembersFromState(state: PresenceStateMap): PresenceMember[] {
  const members: PresenceMember[] = [];
  for (const [userId, metas] of Object.entries(state)) {
    const first = metas[0];
    const displayName =
      typeof first?.displayName === "string"
        ? first.displayName
        : typeof first?.display_name === "string"
          ? first.display_name
          : undefined;
    members.push({ userId, displayName });
  }
  return members;
}
