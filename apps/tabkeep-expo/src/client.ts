import { openNizhalStore } from "@nizhal/db-collection";
import type { TableChangeSource } from "@nizhal/local";
import { customers, ledgerEntries, tabkeepMutators, tabkeepSyncRules } from "./domain";
import { createEcho, createOnlineDetector } from "./echo";

// The client half of the reference: the transport-free domain (schema + sync rules + mutators)
// becomes a live offline-first store — ONE standard: the drizzle-native openNizhalStore over one
// SQLite file (derived real tables + outbox/meta). Queries are the real drizzle query builder.
export async function createTabkeepExpoClient(options: {
  shopId: string;
  userId: string;
  server?: string;
  token?: string;
  refreshToken?: () => Promise<string>;
  /** Dedicated CF realtime Worker host — set for a serverless server (Vercel) + CF Worker realtime. */
  realtimeHost?: string;
  database: any;
  changes?: TableChangeSource;
}) {
  if (!options.server) throw new Error("server is required");
  const echo = createEcho({
    server: options.server,
    token: options.token,
    realtimeHost: options.realtimeHost,
    refreshToken: options.refreshToken,
    bucketsForSyncRule: (rule) => (rule === "myShop" ? [options.shopId] : []),
  });
  const onlineDetector = createOnlineDetector();
  const store = await openNizhalStore({
    echo,
    schema: { customers, ledgerEntries },
    syncRules: tabkeepSyncRules,
    mutators: tabkeepMutators,
    actor: { userId: options.userId, ownerId: options.shopId },
    database: options.database,
    changes: options.changes,
    onlineDetector,
  });
  return { store, mutate: store.mutate, onlineDetector, dispose: store.dispose };
}
