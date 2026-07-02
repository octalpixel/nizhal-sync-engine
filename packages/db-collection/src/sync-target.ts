import type { Cursor, Mutation, PullResult } from "@nizhal/kernel";
import type { NizhalAuthConfig } from "./types.js";

export interface NizhalPullRequest {
  cursor: Cursor;
  syncRule: string;
  buckets: string[];
  clientId: string;
  limit?: number;
}

export interface NizhalPullResponse extends PullResult<Record<string, unknown>> {
  removedBuckets: string[];
  hasMore: boolean;
  lastMutationId?: number;
}

export type NizhalPushRequest = Mutation;

export interface NizhalPushResponse {
  status: "applied" | "duplicate" | "staleSequence" | "outOfOrder" | "rejected";
  result?: unknown;
  serverId?: string;
  error?: string;
  lastMutationId?: number;
}

export interface NizhalSyncTarget {
  pull(request: NizhalPullRequest): Promise<NizhalPullResponse>;
  push(request: NizhalPushRequest): Promise<NizhalPushResponse>;
}

export class NizhalSyncTargetError extends Error {
  readonly retriable: boolean;
  /** Machine-readable cause, e.g. `"upgrade_required"` for a 426 from a fleet-version gate. */
  readonly code?: string;

  constructor(message: string, options: { retriable: boolean; code?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NizhalSyncTargetError";
    this.retriable = options.retriable;
    this.code = options.code;
  }
}

/** Options for the built-in HTTP sync target. */
export interface HttpSyncTargetOptions {
  /**
   * This client's contract/schema version, sent as `x-nizhal-contract-version` so the server can
   * reject a client older than its `minClientVersion` with a `426` (see NizhalServerConfig).
   */
  contractVersion?: string;
}

export interface NizhalAuthState {
  getHeaders(): Record<string, string>;
  refresh?: () => Promise<Record<string, string>>;
}

type ServerSource = string | (() => string | undefined);

export function httpSyncTarget(
  server: ServerSource,
  auth?: NizhalAuthConfig | unknown,
  options?: HttpSyncTargetOptions,
): NizhalSyncTarget {
  return httpSyncTargetWithAuthState(server, createNizhalAuthState(auth), options);
}

// RFC-011 F-C: a push/pull fetch that never settles (stalled connection, serverless cold-start, dropped
// keep-alive) would hold the client's per-client sequence lock forever and silently wedge every queued
// offline write. A timeout turns a hang into an AbortError, which classifyPushError treats as retriable
// (F-A) so the executor retries, the lock releases, and the batch flushes. Override via NIZHAL_FETCH_TIMEOUT_MS.
const DEFAULT_SYNC_FETCH_TIMEOUT_MS = 20_000;
function syncFetchTimeoutMs(): number {
  const raw = Number(globalThis.process?.env?.NIZHAL_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_FETCH_TIMEOUT_MS;
}
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const ms = syncFetchTimeoutMs();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    // Convert our own timeout-abort into a plain retriable Error. A raw AbortError reads as a
    // caller-cancellation and the executor fails the transaction permanently; "timed out" is classified
    // retriable (F-A), so the executor retries and the sequence lock is released.
    if (timedOut) throw new Error(`sync fetch timed out after ${ms}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function httpSyncTargetWithAuthState(
  server: ServerSource,
  auth: NizhalAuthState,
  options?: HttpSyncTargetOptions,
): NizhalSyncTarget {
  const versionHeaders: Record<string, string> = options?.contractVersion
    ? { "x-nizhal-contract-version": options.contractVersion }
    : {};
  const resolveServer = () => {
    const configured = typeof server === "function" ? server() : server;
    return configured?.replace(/\/$/, "");
  };

  async function fetchWithAuthRetry(path: string, init: RequestInit): Promise<Response> {
    const baseUrl = resolveServer();
    if (!baseUrl) {
      throw new Error(`cannot ${path.includes("pull") ? "pull" : "push"}: no server configured`);
    }
    const requestHeaders = init.headers as Record<string, string>;
    let response = await fetchWithTimeout(`${baseUrl}${path}`, {
      ...init,
      headers: { ...auth.getHeaders(), ...requestHeaders },
    });
    if (response.status === 401 && auth.refresh) {
      const refreshed = await auth.refresh();
      response = await fetchWithTimeout(`${resolveServer() ?? baseUrl}${path}`, {
        ...init,
        headers: { ...refreshed, ...requestHeaders },
      });
    }
    return response;
  }

  return {
    async pull(request) {
      const response = await fetchWithAuthRetry("/sync/pull", {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders },
        body: JSON.stringify({
          cursor: request.cursor,
          syncRule: request.syncRule,
          deviceId: request.clientId,
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`pull failed: ${response.status} ${await response.text()}`);
      }
      const result = (await response.json()) as PullResult<Record<string, unknown>>;
      return {
        ...result,
        removedBuckets: result.removedBuckets ?? [],
        hasMore: result.hasMore ?? false,
      };
    },

    async push(request) {
      const response = await fetchWithAuthRetry("/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders },
        body: JSON.stringify({ mutations: [request] }),
      });
      if (response.status === 426) {
        const result = await readJsonRecord(response);
        const message =
          typeof result.error === "string" ? result.error : "client version no longer supported";
        // Retriable + typed: the durable write is preserved and flushes once the app is upgraded —
        // never parked (the mutation is fine; the CLIENT is out of date). The app reads `code` to
        // prompt an update. See NizhalServerConfig.minClientVersion.
        throw new NizhalSyncTargetError(message, { retriable: true, code: "upgrade_required" });
      }
      if (response.status === 409) {
        const result = await readJsonRecord(response);
        const lastMutationId = responseMutationSequence(result, request.clientID);
        return {
          status: "outOfOrder",
          ...(typeof result.error === "string" ? { error: result.error } : {}),
          ...(lastMutationId !== undefined ? { lastMutationId } : {}),
        };
      }
      if (!response.ok) {
        throw new Error(`push failed: ${response.status} ${await response.text()}`);
      }
      const result = await readJsonRecord(response);
      const lastMutationId = responseMutationSequence(result, request.clientID);
      const applied = Array.isArray(result.applied)
        ? result.applied.includes(request.clientMutationId)
        : true;
      return {
        status: applied ? "applied" : "staleSequence",
        ...(lastMutationId !== undefined ? { lastMutationId } : {}),
      };
    },
  };
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  const value = (await response.json()) as unknown;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isSequenceValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function responseMutationSequence(
  response: Record<string, unknown>,
  clientID: string | undefined,
): number | undefined {
  if (isSequenceValue(response.lastMutationId)) return response.lastMutationId;
  if (!clientID || !response.clientSequences || typeof response.clientSequences !== "object") {
    return undefined;
  }
  const value = (response.clientSequences as Record<string, unknown>)[clientID];
  return isSequenceValue(value) ? value : undefined;
}

export function createNizhalAuthState(auth: NizhalAuthConfig | unknown): NizhalAuthState {
  if (auth && typeof auth === "object" && ("headers" in auth || "refresh" in auth)) {
    const config = auth as NizhalAuthConfig;
    let headers = { ...(config.headers ?? {}) };
    return {
      getHeaders: () => headers,
      refresh: config.refresh
        ? async () => {
            const refreshed = await config.refresh?.();
            headers = refreshed ?? headers;
            return headers;
          }
        : undefined,
    };
  }
  return { getHeaders: () => authHeaders(auth) };
}

function authHeaders(auth: unknown): Record<string, string> {
  if (auth && typeof auth === "object" && "headers" in auth) {
    return (auth as { headers?: Record<string, string> }).headers ?? {};
  }
  return {};
}
