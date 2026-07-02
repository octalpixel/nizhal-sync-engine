import type { Cursor } from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import type { DeadLetterStorage } from "../dead-letter.js";
import type { MutationIdStorage } from "../mutation-id.js";
import type { NizhalPoisonEntry } from "../types.js";
import { nizhalDeadLetter, nizhalMeta } from "./control-schema.js";
import type { AnyDrizzleSqliteDb } from "./types.js";

const CURSOR_PREFIX = "cursor:";
const CLIENT_ID_KEY = "client-id";

export interface NizhalMetaStore extends MutationIdStorage {
  getCursor(syncRule: string): Promise<Cursor | undefined>;
  /** Written by pull-apply INSIDE its transaction — pass the tx-scoped db there. */
  setCursor(db: AnyDrizzleSqliteDb, syncRule: string, cursor: Cursor): Promise<void>;
  getOrCreateClientId(): Promise<string>;
}

export function createMetaStore(db: AnyDrizzleSqliteDb): NizhalMetaStore {
  const read = async (key: string): Promise<string | undefined> => {
    const rows = await db
      .select({ value: nizhalMeta.value })
      .from(nizhalMeta)
      .where(eq(nizhalMeta.key, key));
    return rows[0]?.value;
  };
  const write = async (target: AnyDrizzleSqliteDb, key: string, value: string): Promise<void> => {
    await target
      .insert(nizhalMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: nizhalMeta.key, set: { value } });
  };

  return {
    get: async (key) => (await read(key)) ?? null,
    set: (key, value) => write(db, key, value),
    getCursor: async (syncRule) =>
      (await read(`${CURSOR_PREFIX}${syncRule}`)) as Cursor | undefined,
    setCursor: (target, syncRule, cursor) =>
      write(target, `${CURSOR_PREFIX}${syncRule}`, String(cursor)),
    getOrCreateClientId: async () => {
      const existing = await read(CLIENT_ID_KEY);
      if (existing) return existing;
      const id = crypto.randomUUID();
      await write(db, CLIENT_ID_KEY, id);
      return id;
    },
  };
}

export function createDeadLetterStore(db: AnyDrizzleSqliteDb): DeadLetterStorage {
  return {
    async list() {
      const rows = await db.select().from(nizhalDeadLetter);
      return rows.map(
        (row): NizhalPoisonEntry => ({
          idempotencyKey: row.idempotencyKey,
          ...(row.dependencyKey ? { dependencyKey: row.dependencyKey } : {}),
          mutation: row.mutation as unknown as NizhalPoisonEntry["mutation"],
          error: new Error(row.errorMessage),
          parkedAt: row.parkedAt,
        }),
      );
    },
    async park(entry) {
      await db
        .insert(nizhalDeadLetter)
        .values({
          idempotencyKey: entry.idempotencyKey,
          dependencyKey: entry.dependencyKey ?? null,
          mutation: entry.mutation as unknown as Record<string, unknown>,
          errorMessage: entry.error.message,
          parkedAt: entry.parkedAt,
        })
        .onConflictDoNothing();
    },
    async remove(idempotencyKey) {
      await db.delete(nizhalDeadLetter).where(eq(nizhalDeadLetter.idempotencyKey, idempotencyKey));
    },
    async dispose() {
      // the underlying connection belongs to the store; nothing to release here
    },
  };
}
