import {
  type NizhalClient,
  type NizhalClientConfig,
  createNizhalClient,
} from "@nizhal/db-collection";
import { fetch as nitroFetch } from "react-native-nitro-fetch";
import { installNizhalNativePolyfills } from "./native-runtime.js";
import { nitroCloudflareSubscribeSource, nitroWebSocketSource } from "./nitro-ws-source.js";

export { nitroWebSocketSource, nitroCloudflareSubscribeSource } from "./nitro-ws-source.js";
export type {
  NitroWebSocketSourceOptions,
  NitroCloudflareSubscribeSourceOptions,
} from "./nitro-ws-source.js";
export { reactNativeOnlineDetector, installNizhalNativePolyfills } from "./native-runtime.js";
/** The native React Native `fetch` from react-native-nitro-fetch. */
export { nitroFetch };

/**
 * Polyfill the global `fetch` with the native nitro-fetch so Nizhal's HTTP pull/push run on the
 * native networking stack (faster + connection-prewarm-capable on RN). Call once at app start.
 */
export function installNitroFetch(): void {
  (globalThis as { fetch: typeof globalThis.fetch }).fetch =
    nitroFetch as unknown as typeof globalThis.fetch;
}

export interface NizhalNitroClientOptions
  extends Omit<NizhalClientConfig, "server" | "subscribeSource"> {
  server: string;
  /** Bearer token for the realtime WS upgrade (sent as the Authorization header + `?token=`). */
  token?: string;
  /**
   * Dedicated Cloudflare realtime Worker host (e.g. `nizhal-realtime.acme.workers.dev`). Set this when
   * the data server is serverless (no `/sync/stream`, e.g. Vercel functions) and realtime is a CF
   * Worker DO — realtime then connects to the Worker's per-bucket rooms instead of the server's stream.
   */
  realtimeHost?: string;
  /** Polyfill global `fetch` with nitro-fetch (default `true`). */
  useNitroFetch?: boolean;
}

/**
 * `createNizhalClient` wired for React Native: realtime over native WebSockets
 * (`react-native-nitro-websockets`, with header auth) + HTTP over native nitro-fetch.
 * The one-call DX for an Expo/RN Nizhal app.
 */
export function createNizhalNitroClient(opts: NizhalNitroClientOptions): NizhalClient {
  installNizhalNativePolyfills();
  if (opts.useNitroFetch !== false) installNitroFetch();
  const { token, realtimeHost, useNitroFetch: _useNitroFetch, ...config } = opts;
  const subscribeSource = realtimeHost
    ? nitroCloudflareSubscribeSource({ host: realtimeHost, getToken: () => Promise.resolve(token ?? "") })
    : nitroWebSocketSource({ server: config.server, token });
  return createNizhalClient({ ...config, subscribeSource });
}
