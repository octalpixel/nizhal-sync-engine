import { type NizhalSQLitePersistence, opSqlitePersistence } from "@nizhal/db-collection";
import { open } from "@op-engineering/op-sqlite";

// Durable on-device chat replica (separate DB from tabkeep). Survives app restart — the persist-after-
// reconnect guarantee: messages written on the phone are on disk and reconcile with Neon on reconnect.
export async function openChatPersistence(): Promise<NizhalSQLitePersistence | undefined> {
  return opSqlitePersistence({ database: open({ name: "chat.db" }) });
}
