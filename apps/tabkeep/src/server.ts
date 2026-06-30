import type { MutatorRegistry } from "@nizhal/kernel";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import type { RealtimeAdapter, StorageAdapter } from "@nizhal/server/adapters";
import { tabkeepMutators } from "./mutators.js";
import { tabkeepSchema } from "./schema.js";
import { tabkeepSyncRules } from "./sync-rules.js";

export interface TabkeepServerOptions {
  db: string;
  secret: string;
  storage?: StorageAdapter;
  realtime?: RealtimeAdapter;
  cors?: boolean;
}

export function createTabkeepServer(options: TabkeepServerOptions) {
  return createNizhalServer({
    db: options.db,
    schema: tabkeepSchema,
    mutators: tabkeepMutators as MutatorRegistry,
    syncRules: tabkeepSyncRules,
    auth: bearerTokenAuth({ secret: options.secret }),
    storage: options.storage,
    realtime: options.realtime,
    cors: options.cors,
  });
}
