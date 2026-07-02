// React Native helpers — the two carry-overs from the folded @nizhal/react-native package.
// Kept behind the `@nizhal/db-collection/react-native` subpath so the RN-only deps
// (react-native-nitro-fetch, @react-native-community/netinfo) never load on web/Node, which
// import only the core barrel. Both are typed against the Nizhal-owned OnlineDetector.
import NetInfo from "@react-native-community/netinfo";
import { fetch as nitroFetch } from "react-native-nitro-fetch";
import type { OnlineDetector } from "./types.js";

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

/**
 * NetInfo-based connectivity detector for Nizhal's outbox on React Native. Pass it (usually wrapped
 * in `manualOnlineDetector`) to `openNizhalStore({ onlineDetector })` so the outbox auto-flushes the
 * moment the device regains connectivity. Without it the store never learns about network changes on
 * RN and only retries on the next manual pull/mutation.
 *
 * Requires the `@react-native-community/netinfo` peer dependency.
 */
export function reactNativeOnlineDetector(): OnlineDetector {
  const listeners = new Set<() => void>();
  let online = true;
  let unsubscribeNetInfo: (() => void) | null = null;

  const startListening = () => {
    if (unsubscribeNetInfo) return;
    void NetInfo.fetch()
      .then((state) => {
        online = state.isConnected !== false;
      })
      .catch(() => {});
    unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      const next = state.isConnected !== false;
      if (next && !online) {
        for (const listener of listeners) listener();
      }
      online = next;
    });
  };

  return {
    isOnline() {
      return online;
    },
    subscribe(callback) {
      listeners.add(callback);
      startListening();
      return () => {
        listeners.delete(callback);
      };
    },
    notifyOnline() {
      for (const listener of listeners) listener();
    },
    dispose() {
      listeners.clear();
      unsubscribeNetInfo?.();
      unsubscribeNetInfo = null;
    },
  };
}
