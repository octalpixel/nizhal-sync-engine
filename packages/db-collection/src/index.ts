// @nizhal/db-collection — the sync client. ONE standard: the drizzle-native store
// (rfc-drizzle-native-sync-client). The legacy TanStack blob plane was removed after the
// unification (git history: openNizhalCollectionsStore and friends).

// ---- the store ---------------------------------------------------------------------------
export { openNizhalStore } from "./drizzle/store.js";
export type { NizhalStore, OpenNizhalStoreOptions } from "./drizzle/store.js";
export { drizzleMutatorTx } from "./drizzle/mutator-tx.js";
export { nizhalDeadLetter, nizhalMeta, nizhalOutbox } from "./drizzle/control-schema.js";
export type { DeadLetterStorage } from "./dead-letter.js";

// ---- transport / session ------------------------------------------------------------------
export type { NizhalClient, NizhalPushResult } from "./client.js";
export {
  createCloudflareSubscribeSource,
  createNizhalClient,
  createPartySocketSource,
} from "./client.js";
export { createWebSocketSource } from "./websocket-source.js";
export type {
  WebSocketFactory,
  WebSocketHeartbeatOptions,
  WebSocketLike,
  WebSocketReconnectOptions,
  WebSocketSourceOptions,
} from "./websocket-source.js";
export { NizhalSyncTargetError, httpSyncTarget } from "./sync-target.js";
export type {
  NizhalPullRequest,
  NizhalPullResponse,
  NizhalPushRequest,
  NizhalPushResponse,
  NizhalSyncTarget,
} from "./sync-target.js";
export {
  kvSessionStore,
  localStorageSessionStore,
  startLocalFirstBootstrap,
} from "./bootstrap.js";
export type {
  LocalFirstBootstrap,
  LocalFirstBootstrapOptions,
  NizhalKvStore,
  NizhalSessionStore,
} from "./bootstrap.js";
export { manualOnlineDetector } from "./manual-online-detector.js";
export type { ManualOnlineDetector } from "./manual-online-detector.js";

// ---- presence / blobs / status --------------------------------------------------------------
export {
  onPresence,
  presence,
  presenceState,
  subscribePresence,
  track,
  untrack,
} from "./presence.js";
export { createNizhalBlobs, keyForBlob, memoryBlobStore } from "./blob.js";
export type { BlobStore, NizhalBlobs } from "./blob.js";
export { createNizhalStatus, createNoopNizhalStatus } from "./status.js";
export type { NizhalStatus, NizhalStatusController, SyncStatus } from "./status.js";

// ---- shared types ---------------------------------------------------------------------------
export { NonRetriableError } from "./types.js";
export type {
  NizhalAuthConfig,
  NizhalClientConfig,
  NizhalMode,
  NizhalMutatorDefinition,
  NizhalPoisonEntry,
  NizhalPresenceConfig,
  NizhalPullConfig,
  NizhalReconnectConfig,
  NizhalSubscribeSource,
  NizhalTtlConfig,
  OnlineDetector,
  PresenceDiff,
  PresenceEvent,
  PresenceMember,
  PresenceMeta,
  PresenceStateMap,
} from "./types.js";
