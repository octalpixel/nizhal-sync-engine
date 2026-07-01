import { is } from "drizzle-orm";
import { SQLiteRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/query";
import { useEffect, useState } from "react";
import type { LocalDb, WatchOptions } from "./types.js";

/**
 * Cross-platform version of drizzle's expo-only `useLiveQuery` — same signature and return
 * shape, but works over any `openLocalDb` handle (expo-sqlite, op-sqlite, browser wa-sqlite).
 *
 * ```ts
 * const { data } = useLiveQuery(local, local.db.select().from(schema.tasks));
 * ```
 */
export function useLiveQuery<T>(
  local: Pick<LocalDb<unknown>, "watch">,
  query: PromiseLike<T>,
  deps: unknown[] = [],
  options?: WatchOptions,
): { data: T | undefined; error: Error | undefined; updatedAt: Date | undefined } {
  const [state, setState] = useState<{
    data: T | undefined;
    error: Error | undefined;
    updatedAt: Date | undefined;
  }>(() => ({
    data:
      is(query, SQLiteRelationalQuery) && (query as unknown as { mode: string }).mode === "first"
        ? undefined
        : ([] as unknown as T),
    error: undefined,
    updatedAt: undefined,
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are caller-provided, same contract as drizzle's own hook.
  useEffect(() => local.watch(query, setState, options), deps);

  return state;
}
