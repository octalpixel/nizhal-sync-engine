import type { NizhalPoisonEntry } from "./types.js";

export interface DeadLetterStorage {
  list(): Promise<readonly NizhalPoisonEntry[]>;
  park(entry: NizhalPoisonEntry): Promise<void>;
  remove(idempotencyKey: string): Promise<void>;
  dispose(): Promise<void>;
}
