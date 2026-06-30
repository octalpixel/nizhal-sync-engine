import NetInfo from "@react-native-community/netinfo";
import type { OnlineDetector } from "@tanstack/offline-transactions";

/**
 * NetInfo-based connectivity detector for Nizhal's offline executor on React Native.
 * Pass it to `createNizhalMutators({ onlineDetector: reactNativeOnlineDetector() })` so the outbox
 * auto-flushes the moment the device regains connectivity. Without it the executor never learns
 * about network changes on RN and only retries on the next manual pull/mutation.
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

/**
 * Install `crypto.randomUUID` when it is missing — some React Native Hermes versions lack it, and the
 * offline transaction layer needs it for client mutation IDs. Prefers `crypto.getRandomValues`
 * (install `react-native-get-random-values` first) and falls back to `Math.random`. Call once at app
 * start, before constructing clients/mutators. `createNizhalNitroClient` calls this for you.
 */
export function installNizhalNativePolyfills(): void {
  const target = globalThis as { crypto?: Partial<Crypto> };
  if (typeof target.crypto === "undefined") {
    target.crypto = {} as Crypto;
  }
  if (typeof target.crypto.randomUUID !== "function") {
    target.crypto.randomUUID = (() => uuidV4()) as Crypto["randomUUID"];
  }
}

function uuidV4(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = (Math.random() * 256) | 0;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}` as `${string}-${string}-${string}-${string}-${string}`;
}
