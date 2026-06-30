import type { MutatorRegistry } from "@nizhal/kernel";
import { bearerTokenAuth, createNizhalServer, signHs256Jwt } from "@nizhal/server";
import type { BlobAdapter, RealtimeAdapter, StorageAdapter } from "@nizhal/server/adapters";
import type { ChainRole } from "./schema.js";
import { chainMutators } from "./mutators.js";
import { chainSchema } from "./schema.js";
import { chainSyncRules } from "./sync-rules.js";

export interface ChainServerOptions {
  db: string;
  secret: string;
  storage?: StorageAdapter;
  realtime?: RealtimeAdapter;
  blob?: BlobAdapter;
}

export function createTabkeepChainServer(options: ChainServerOptions) {
  return createNizhalServer({
    db: options.db,
    schema: chainSchema,
    mutators: chainMutators as MutatorRegistry,
    syncRules: chainSyncRules,
    auth: bearerTokenAuth({ secret: options.secret }),
    storage: options.storage,
    realtime: options.realtime,
    blob: options.blob,
  });
}

// Role-carrying bearer token. The default verify returns the whole signed payload as the actor, so
// `role` reaches the mutator as ctx.actor.role — signed, hence tamper-proof. `branchId` is the
// actor's active branch (ctx.ownerId); read access is still bounded by branch_members membership.
export function mintChainToken(input: {
  secret: string;
  userId: string;
  branchId: string;
  role: ChainRole;
  expiresInSec?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (input.expiresInSec ?? 3600);
  return signHs256Jwt(
    { userId: input.userId, ownerId: input.branchId, role: input.role, exp },
    input.secret,
  );
}
