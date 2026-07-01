// The local-first launch dance, folded into the framework. Every offline-first app repeats the same
// sequence: open the LOCAL replica immediately from a cached session (works fully offline), then
// refresh the session in the background without ever blocking the UI — and on a first-ever launch
// with no cache, retry until the server is first reachable, then open. This owns that sequence so an
// app supplies only `fetchSession`, a `sessionStore`, and how to `openStore`.

/** A durable get/set key-value store — `persistence.metaStorage` satisfies this shape. */
export interface NizhalKvStore {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** Loads/saves the cached session that lets a cold, offline launch open the local replica. */
export interface NizhalSessionStore<S> {
  load(): Promise<S | null>;
  save(session: S): Promise<void>;
}

/** Session cache over any {@link NizhalKvStore} (e.g. the durable `persistence.metaStorage`). */
export function kvSessionStore<S>(kv: NizhalKvStore, key: string): NizhalSessionStore<S> {
  return {
    async load() {
      try {
        const raw = await kv.get(key);
        return raw ? (JSON.parse(raw) as S) : null;
      } catch {
        return null;
      }
    },
    async save(session) {
      try {
        await kv.set(key, JSON.stringify(session));
      } catch {
        // best-effort cache; a failure here only costs an extra online bootstrap next launch
      }
    },
  };
}

/** Session cache over `globalThis.localStorage` — the web fallback when there's no SQLite persistence. */
export function localStorageSessionStore<S>(key: string): NizhalSessionStore<S> {
  return {
    async load() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? (JSON.parse(raw) as S) : null;
      } catch {
        return null;
      }
    },
    async save(session) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(session));
      } catch {
        // best-effort cache
      }
    },
  };
}

export interface LocalFirstBootstrapOptions<S, C extends { dispose(): unknown }> {
  sessionStore: NizhalSessionStore<S>;
  /** Fetch a fresh session from the server (identity + token). */
  fetchSession: () => Promise<S>;
  /**
   * Open the client store for a session. `refreshSession` re-fetches and re-caches the session — wire
   * it into the client's token refresh so each 401 refresh also updates the offline cache.
   */
  openStore: (session: S, ctx: { refreshSession: () => Promise<S> }) => Promise<C>;
  /** Called with the opened client once the local replica is live (may be called before the refresh). */
  onOpen: (client: C) => void;
  /** Called `true` while a first-ever launch is blocked waiting for the server, `false` once open. */
  onConnectionRequired?: (required: boolean) => void;
  /** Backoff between reachability retries on a first-ever (uncached) launch. Default 3000ms. */
  retryDelayMs?: number;
}

export interface LocalFirstBootstrap {
  dispose(): void;
}

export function startLocalFirstBootstrap<S, C extends { dispose(): unknown }>(
  opts: LocalFirstBootstrapOptions<S, C>,
): LocalFirstBootstrap {
  let cancelled = false;
  let opened: C | null = null;

  const refreshSession = async (): Promise<S> => {
    const fresh = await opts.fetchSession();
    await opts.sessionStore.save(fresh);
    return fresh;
  };

  const open = async (session: S): Promise<void> => {
    const client = await opts.openStore(session, { refreshSession });
    if (cancelled) {
      void client.dispose();
      return;
    }
    opened = client;
    opts.onOpen(client);
    opts.onConnectionRequired?.(false);
  };

  void (async () => {
    // 1. Local-first: with a cached session, open the local replica immediately — works fully offline.
    const cached = await opts.sessionStore.load();
    if (cached && !cancelled) await open(cached);

    // 2. Background refresh: never blocks the local UI. With a cache we try once (the live client
    //    self-heals via auth.refresh on reconnect); with no cache we retry until the server is first
    //    reachable, then open.
    const delay = opts.retryDelayMs ?? 3000;
    while (!cancelled) {
      try {
        const fresh = await refreshSession();
        if (!cached && !cancelled) await open(fresh);
        break;
      } catch {
        if (cached) break;
        opts.onConnectionRequired?.(true);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  })();

  return {
    dispose() {
      cancelled = true;
      void opened?.dispose();
    },
  };
}
