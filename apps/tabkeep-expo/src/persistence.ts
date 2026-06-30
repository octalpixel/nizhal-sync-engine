import type { NizhalSQLitePersistence } from "@nizhal/db-collection";

// Web / default persistence. In-memory for now (records sync but don't survive a reload); durable
// web persistence via wa-sqlite under Metro is the next increment. Metro picks persistence.native.ts
// for iOS/Android, which uses op-sqlite for durable on-device storage.
export async function openTabkeepPersistence(): Promise<NizhalSQLitePersistence | undefined> {
  return undefined;
}
