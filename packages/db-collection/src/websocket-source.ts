import type { OnlineDetector } from "@tanstack/offline-transactions";
import type { NizhalSubscribeSource } from "./types.js";

/**
 * Minimal WHATWG-`WebSocket` subset that the browser `WebSocket`, React Native's `NitroWebSocket`,
 * and Node's `ws` all satisfy. The transport is injected as a {@link WebSocketFactory} so a single
 * reconnecting source works on every platform — the web-standard interface is the contract.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown; isBinary?: boolean }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * Constructs a {@link WebSocketLike}. `headers` is honoured by transports that can set upgrade
 * headers (NitroWebSocket, `ws`); the browser `WebSocket` ignores it, so web callers carry auth in
 * the URL query instead. Re-invoked on every (re)connect by {@link createWebSocketSource}.
 */
export type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
  headers?: Record<string, string>,
) => WebSocketLike;

export interface WebSocketReconnectOptions {
  /** First backoff delay (ms). Default 1000. */
  minDelayMs?: number;
  /** Backoff cap (ms). Default 10000. */
  maxDelayMs?: number;
  /** Exponential growth factor per attempt. Default 1.5. */
  growthFactor?: number;
  /** Connection must stay open this long before the backoff counter resets — prevents an
   *  accept-then-close server from causing a hot reconnect loop. Default 5000. */
  minUptimeMs?: number;
  /** Abort and retry a connect that hasn't opened within this window. Default 4000. */
  connectTimeoutMs?: number;
}

export interface WebSocketHeartbeatOptions {
  /** Send a ping after this much idle time. Default 25000. */
  intervalMs?: number;
  /** Reconnect if no frame arrives within this window after a ping. Default 10000. */
  timeoutMs?: number;
  /** The ping payload. Default `"ping"`. Requires the server to echo (see `isPong`). */
  message?: string;
  /** Identifies the pong frame (treated as liveness only, not delivered to `onMessage`).
   *  Default `(d) => d === "pong"`. */
  isPong?: (data: string) => boolean;
}

export interface WebSocketSourceOptions {
  /** Built fresh on every (re)connect, so a refreshed token in the URL is always used. May be async
   *  (e.g. resolving a token); a synchronous string keeps connection setup synchronous. */
  getUrl: (buckets: string[]) => string | Promise<string>;
  webSocketFactory: WebSocketFactory;
  /** Read fresh on every (re)connect and passed to the factory (header-auth transports). */
  getHeaders?: () => Record<string, string>;
  /** Invoked when a connect attempt closes *before opening* (the upgrade-time auth/network failure
   *  mode). Refresh the token here; the next attempt re-reads `getUrl`/`getHeaders`. Resolve `false`
   *  to stop retrying (auth-fatal), `true`/void to keep backing off. */
  // biome-ignore lint/suspicious/noConfusingVoidType: void is intentional — the contract accepts void-returning callbacks (() => void); undefined would reject them
  onConnectFailure?: () => Promise<boolean | void> | boolean | void;
  reconnect?: WebSocketReconnectOptions;
  /** Application-level heartbeat. Off unless provided (it needs a server that echoes the ping). */
  heartbeat?: WebSocketHeartbeatOptions;
  /** Reconnect immediately when connectivity returns instead of waiting out the backoff. */
  onlineDetector?: OnlineDetector;
}

/**
 * A single reconnecting {@link NizhalSubscribeSource} over an injected {@link WebSocketFactory}.
 * Backoff + full jitter, a stability gate before resetting the counter, a connect timeout, an
 * optional heartbeat, fresh auth per attempt, and online-aware fast reconnect. The realtime frame
 * is only a hint — the client's catch-up pull on `onReconnect` stays authoritative.
 */
export function createWebSocketSource(options: WebSocketSourceOptions): NizhalSubscribeSource {
  const minDelay = options.reconnect?.minDelayMs ?? 1_000;
  const maxDelay = options.reconnect?.maxDelayMs ?? 10_000;
  const growth = options.reconnect?.growthFactor ?? 1.5;
  const minUptime = options.reconnect?.minUptimeMs ?? 5_000;
  const connectTimeoutMs = options.reconnect?.connectTimeoutMs ?? 4_000;
  const hb = options.heartbeat;
  const hbInterval = hb?.intervalMs ?? 25_000;
  const hbTimeout = hb?.timeoutMs ?? 10_000;
  const hbMessage = hb?.message ?? "ping";
  const isPong = hb?.isPong ?? ((d: string) => d === "pong");

  let socket: WebSocketLike | null = null;
  let isOpen = false;
  let closedByCaller = false;
  let hasConnectedOnce = false;
  let retryCount = 0;

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let onlineUnsub: (() => void) | null = null;

  function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
    if (t) clearTimeout(t);
    return null;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    pongTimer = clearTimer(pongTimer);
  }

  function startHeartbeat() {
    if (!hb) return;
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!socket || !isOpen) return;
      try {
        socket.send(hbMessage);
      } catch {
        // a close/error will follow and drive reconnection
      }
      if (!pongTimer) {
        pongTimer = setTimeout(() => {
          // No frame since the ping → treat as half-open and force a reconnect.
          socket?.close(4000, "heartbeat timeout");
        }, hbTimeout);
      }
    }, hbInterval);
  }

  function noteTraffic() {
    // Any inbound frame proves liveness, satisfying the heartbeat window.
    pongTimer = clearTimer(pongTimer);
  }

  function nextDelay(): number {
    const base = Math.min(maxDelay, minDelay * growth ** Math.max(0, retryCount - 1));
    // Full jitter over the lower half keeps a floor while spreading the herd.
    return base * (0.5 + Math.random() * 0.5);
  }

  function teardownSocket() {
    if (!socket) return;
    isOpen = false;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // already closing/closed
    }
    socket = null;
  }

  function scheduleReconnect() {
    if (closedByCaller) return;
    if (options.onlineDetector && options.onlineDetector.isOnline() === false) {
      // Offline: don't burn retries; the online subscription reconnects the moment we're back.
      return;
    }
    retryCount += 1;
    reconnectTimer = setTimeout(connect, nextDelay());
  }

  function connect(buckets: string[] = currentBuckets) {
    if (closedByCaller) return;
    reconnectTimer = clearTimer(reconnectTimer);
    stopHeartbeat();

    let urlResult: string | Promise<string>;
    try {
      urlResult = options.getUrl(buckets);
    } catch {
      void handleConnectFailure();
      return;
    }
    // Keep the common synchronous case synchronous; only the CF async-token path defers a microtask.
    if (typeof urlResult === "string") {
      openSocket(urlResult);
    } else {
      urlResult.then(
        (url) => {
          if (!closedByCaller) openSocket(url);
        },
        () => {
          void handleConnectFailure();
        },
      );
    }
  }

  function openSocket(url: string) {
    if (closedByCaller) return;
    let openedThisAttempt = false;
    const headers = options.getHeaders?.();
    let ws: WebSocketLike;
    try {
      ws = options.webSocketFactory(url, undefined, headers);
    } catch {
      void handleConnectFailure();
      return;
    }
    socket = ws;

    connectTimer = setTimeout(() => {
      if (!openedThisAttempt) {
        // Stuck connecting → abort; onclose drives the retry.
        teardownSocket();
        void handleConnectFailure();
      }
    }, connectTimeoutMs);

    ws.onopen = () => {
      openedThisAttempt = true;
      isOpen = true;
      connectTimer = clearTimer(connectTimer);
      // Only reset the backoff counter once the connection proves stable.
      stableTimer = setTimeout(() => {
        retryCount = 0;
      }, minUptime);
      startHeartbeat();
      if (hasConnectedOnce) {
        onReconnectCb?.();
      } else {
        hasConnectedOnce = true;
      }
    };

    ws.onmessage = (event) => {
      noteTraffic();
      if (typeof event.data !== "string") return;
      if (hb && isPong(event.data)) return;
      onMessageCb?.(event.data);
    };

    ws.onclose = () => {
      isOpen = false;
      connectTimer = clearTimer(connectTimer);
      stableTimer = clearTimer(stableTimer);
      stopHeartbeat();
      if (closedByCaller) return;
      if (openedThisAttempt) {
        scheduleReconnect();
      } else {
        // Closed before opening — the upgrade-time auth/network failure mode.
        void handleConnectFailure();
      }
    };

    ws.onerror = () => {
      // A close event always follows; reconnection is handled there.
    };
  }

  async function handleConnectFailure() {
    if (closedByCaller) return;
    if (options.onConnectFailure) {
      const proceed = await options.onConnectFailure();
      if (proceed === false) return; // auth-fatal: stop retrying, surface upstream via no reconnect
    }
    scheduleReconnect();
  }

  let currentBuckets: string[] = [];
  let onMessageCb: ((data: string) => void) | null = null;
  let onReconnectCb: (() => void) | null = null;

  return {
    subscribe(buckets, onMessage, onReconnect) {
      closedByCaller = false;
      hasConnectedOnce = false;
      retryCount = 0;
      currentBuckets = buckets;
      onMessageCb = onMessage;
      onReconnectCb = onReconnect ?? null;

      if (options.onlineDetector) {
        onlineUnsub = options.onlineDetector.subscribe(() => {
          if (closedByCaller) return;
          if (isOpen) return;
          // Network is back — cancel any pending backoff and reconnect now.
          reconnectTimer = clearTimer(reconnectTimer);
          retryCount = 0;
          connect();
        });
      }

      connect(buckets);

      return () => {
        closedByCaller = true;
        reconnectTimer = clearTimer(reconnectTimer);
        connectTimer = clearTimer(connectTimer);
        stableTimer = clearTimer(stableTimer);
        stopHeartbeat();
        onlineUnsub?.();
        onlineUnsub = null;
        teardownSocket();
      };
    },
    send(data) {
      if (socket && isOpen) socket.send(data);
    },
  };
}
