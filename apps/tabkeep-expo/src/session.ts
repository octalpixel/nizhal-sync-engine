// Web session cache (localStorage). The session ({shopId, userId, token}) is persisted after the
// first successful fetch so the app can open the LOCAL replica offline on the next launch instead of
// blocking on the network. Metro picks session.native.ts on iOS/Android (op-sqlite-backed).
export interface CachedSession {
  shopId: string;
  userId: string;
  token: string;
}

const KEY = "tabkeep.session";

export async function loadSession(): Promise<CachedSession | null> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as CachedSession) : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: CachedSession): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(session));
  } catch {
    // best-effort cache; a failure here only costs an extra online bootstrap next launch
  }
}
