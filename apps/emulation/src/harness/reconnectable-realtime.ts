import type { RealtimeAdapter } from "@nizhal/server/adapters";

export interface ReconnectableRealtime extends RealtimeAdapter {
  disconnect(): void;
  reconnect(): void;
  /** Pokes actually delivered to subscribers (not swallowed while disconnected). */
  deliveredPublishCount(): number;
}

export function reconnectableRealtime(): ReconnectableRealtime {
  const registry = new Map<
    string,
    Set<{ send: (data: string) => void; onReconnect?: () => void }>
  >();
  let connected = true;
  let deliveredPublishes = 0;

  return {
    publish(bucket) {
      if (!connected) return;
      const subs = registry.get(bucket);
      if (!subs || subs.size === 0) return;
      deliveredPublishes += 1;
      for (const socket of subs) socket.send(`repull:${bucket}`);
    },
    subscribe(buckets, socket) {
      for (const bucket of buckets) {
        let set = registry.get(bucket);
        if (!set) {
          set = new Set();
          registry.set(bucket, set);
        }
        set.add(socket);
      }
      return () => {
        for (const bucket of buckets) registry.get(bucket)?.delete(socket);
      };
    },
    disconnect() {
      connected = false;
    },
    reconnect() {
      if (connected) return;
      connected = true;
      for (const subs of registry.values()) {
        for (const socket of subs) socket.onReconnect?.();
      }
    },
    deliveredPublishCount() {
      return deliveredPublishes;
    },
  };
}
