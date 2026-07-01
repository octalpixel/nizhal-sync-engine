// Native session cache (op-sqlite). Persists the session ({shopId, userId, token}) so a cold start
// while offline opens the local replica immediately from the cached identity instead of hard-failing
// on the /demo/session fetch. Kept in its own tiny db so it never contends with the sync store.
import { type DB, open } from "@op-engineering/op-sqlite";

export interface CachedSession {
  shopId: string;
  userId: string;
  token: string;
}

let db: DB | null = null;

async function conn(): Promise<DB> {
  if (!db) {
    db = open({ name: "tabkeep-session.db" });
    await db.execute("create table if not exists kv (k text primary key, v text not null)");
  }
  return db;
}

// op-sqlite has returned rows as a plain array (v9+) or a { _array } wrapper across versions — read defensively.
function firstRow(result: unknown): { v?: string } | undefined {
  const rows = (result as { rows?: unknown }).rows;
  if (Array.isArray(rows)) return rows[0] as { v?: string } | undefined;
  const wrapper = rows as { _array?: unknown[] } | undefined;
  return wrapper?._array?.[0] as { v?: string } | undefined;
}

export async function loadSession(): Promise<CachedSession | null> {
  try {
    const result = await (await conn()).execute("select v from kv where k = ?", ["session"]);
    const row = firstRow(result);
    return row?.v ? (JSON.parse(row.v) as CachedSession) : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: CachedSession): Promise<void> {
  try {
    await (await conn()).execute(
      "insert into kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v",
      ["session", JSON.stringify(session)],
    );
  } catch {
    // best-effort cache; a failure here only costs an extra online bootstrap next launch
  }
}
