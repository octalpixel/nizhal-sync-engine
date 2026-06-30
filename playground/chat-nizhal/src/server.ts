import type { MutatorRegistry } from "@nizhal/kernel";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import type { RealtimeAdapter, StorageAdapter } from "@nizhal/server/adapters";
import { chatMutators, chatSchema, chatSyncRules } from "./domain.js";

export interface ChatServerOptions {
  db: string;
  secret: string;
  storage?: StorageAdapter;
  realtime?: RealtimeAdapter;
  cors?: boolean;
}

// One Hono server, same engine as tabkeep. The DO-shaped decisions live entirely in the domain:
// chatSyncRules makes a channel a membership-gated bucket; chatMutators name the channel(s) to poke.
export function createChatServer(options: ChatServerOptions) {
  return createNizhalServer({
    db: options.db,
    schema: chatSchema,
    mutators: chatMutators as MutatorRegistry,
    syncRules: chatSyncRules,
    auth: bearerTokenAuth({ secret: options.secret }),
    storage: options.storage,
    realtime: options.realtime,
    cors: options.cors,
  });
}
