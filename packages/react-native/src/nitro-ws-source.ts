import {
  type NizhalSubscribeSource,
  type WebSocketFactory,
  type WebSocketLike,
  createCloudflareSubscribeSource,
  createWebSocketSource,
} from "@nizhal/db-collection";
import { NitroWebSocket } from "react-native-nitro-websockets";

export interface NitroWebSocketSourceOptions {
  /** Nizhal server base URL (http/https); converted to ws/wss for `/sync/stream`. */
  server: string;
  /** Bearer token. Sent as the `Authorization` **header** on the WS upgrade (the RN edge —
   *  browser/Node WebSocket can't set upgrade headers), plus a `?token=` query fallback so it
   *  works whichever the server reads. */
  token?: string;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/** NitroWebSocket (native libwebsockets) as a {@link WebSocketFactory} — WHATWG-shaped, and the one
 *  transport that can set the `Authorization` upgrade header on React Native. */
const nitroWebSocketFactory: WebSocketFactory = (url, protocols, headers) =>
  new NitroWebSocket(url, protocols, headers) as unknown as WebSocketLike;

/**
 * An {@link NizhalSubscribeSource} backed by `react-native-nitro-websockets`. It plugs NitroWebSocket
 * into the shared {@link createWebSocketSource} engine, so it inherits the same robust reconnection as
 * every other platform — exponential backoff + jitter, a stability gate (no hot-loop on
 * accept-then-close), a connect timeout, and online-aware fast reconnect. `onReconnect` runs a
 * catch-up pull (REQ-25); the realtime ping is only a hint, the cursor pull stays authoritative.
 */
export function nitroWebSocketSource(opts: NitroWebSocketSourceOptions): NizhalSubscribeSource {
  const base = opts.server.replace(/\/+$/, "").replace(/^http/, "ws");
  const query = opts.token ? `?token=${encodeURIComponent(opts.token)}` : "";
  const url = `${base}/sync/stream${query}`;
  const headers = opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined;

  return createWebSocketSource({
    getUrl: () => url,
    getHeaders: headers ? () => headers : undefined,
    webSocketFactory: nitroWebSocketFactory,
    reconnect: {
      minDelayMs: opts.minReconnectDelayMs,
      maxDelayMs: opts.maxReconnectDelayMs,
    },
  });
}

export interface NitroCloudflareSubscribeSourceOptions {
  /** Realtime Worker host, e.g. `nizhal-realtime.acme.workers.dev` (ws/wss inferred). */
  host: string;
  /** Returns a fresh bearer for the `?token=` on each (re)connect. */
  getToken: () => Promise<string>;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/**
 * Cloudflare Worker realtime for React Native — the RN counterpart of the web
 * {@link createCloudflareSubscribeSource}. Reuses that exact per-bucket `/parties/nizhal-bucket/<bucket>`
 * routing but drives it with the native {@link NitroWebSocket} factory. Use when the data server is
 * serverless (no `/sync/stream`, e.g. Vercel functions) and realtime is a dedicated CF Worker DO.
 */
export function nitroCloudflareSubscribeSource(
  opts: NitroCloudflareSubscribeSourceOptions,
): NizhalSubscribeSource {
  return createCloudflareSubscribeSource(
    opts.host,
    opts.getToken,
    {
      minReconnectionDelay: opts.minReconnectDelayMs,
      maxReconnectionDelay: opts.maxReconnectDelayMs,
    },
    nitroWebSocketFactory,
  );
}
