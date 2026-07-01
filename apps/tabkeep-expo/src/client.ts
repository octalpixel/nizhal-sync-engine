// Legacy (blob-plane) store on purpose: tabkeep ships its release on the proven plane;
// it migrates to the drizzle-native openNizhalStore after that release
// (rfc-local-sync-convergence §10 stage 3).
import { type NizhalSQLitePersistence, openNizhalCollectionsStore } from "@nizhal/db-collection";
import { customers, ledgerEntries, tabkeepMutators, tabkeepSyncRules } from "./domain";
import { createEcho, createOnlineDetector } from "./echo";

// The client half of the reference: turn the transport-free domain (schema + sync rules + mutators)
// into a live, offline-first store. Everything below the `createEcho`/`createOnlineDetector` platform
// seam is framework — one `openNizhalStore` call. This is the "~10 lines" the productization work bought.
export async function createTabkeepExpoClient(options: {
  shopId: string;
  userId: string;
  server?: string;
  token?: string;
  refreshToken?: () => Promise<string>;
  /** Dedicated CF realtime Worker host — set for a serverless server (Vercel) + CF Worker realtime. */
  realtimeHost?: string;
  persistence?: NizhalSQLitePersistence;
}) {
  if (!options.server) throw new Error("server is required");
  // Transport is platform-picked by Metro: nitro fetch/websockets on native, browser fetch/WebSocket
  // on web (src/echo.native.ts vs src/echo.ts). Same client/outbox/collections either way.
  const echo = createEcho({
    server: options.server,
    token: options.token,
    realtimeHost: options.realtimeHost,
    refreshToken: options.refreshToken,
    bucketsForSyncRule: (rule) => (rule === "myShop" ? [options.shopId] : []),
  });
  // Connectivity detector, platform-picked (NetInfo on native, browser online events on web), wrapped
  // for deterministic manual override — `setOnline(false)` holds the outbox regardless of the network.
  const onlineDetector = createOnlineDetector();
  const store = await openNizhalCollectionsStore({
    echo,
    schema: { customers, ledgerEntries },
    syncRules: tabkeepSyncRules,
    mutators: tabkeepMutators,
    actor: { userId: options.userId, ownerId: options.shopId },
    persistence: options.persistence,
    onlineDetector,
  });
  return {
    customers: store.collections.customers,
    ledgerEntries: store.collections.ledgerEntries,
    mutate: store.mutate,
    onlineDetector,
    dispose: store.dispose,
  };
}
