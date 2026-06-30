import { type NizhalSQLitePersistence, opSqlitePersistence } from "@nizhal/db-collection";
import { open } from "@op-engineering/op-sqlite";

// Native (iOS + Android): durable on-device store via op-sqlite. Default location resolves to the
// app's per-platform documents directory. Same Nizhal client/outbox as web — only the local store
// differs. This is the offline-first guarantee: writes persist on the device and survive restarts.
export async function openTabkeepPersistence(): Promise<NizhalSQLitePersistence | undefined> {
  const database = open({ name: "tabkeep.db" });
  return opSqlitePersistence({ database });
}
