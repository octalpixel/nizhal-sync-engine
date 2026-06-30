import type { NizhalSQLitePersistence } from "@nizhal/db-collection";
export async function openChatPersistence(): Promise<NizhalSQLitePersistence | undefined> {
  return undefined; // web/default: in-memory (Metro picks persistence.native.ts on device)
}
