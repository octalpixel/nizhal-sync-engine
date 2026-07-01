import { describe, expect, it } from "vitest";
import { type NizhalSessionStore, startLocalFirstBootstrap } from "../src/bootstrap.js";

interface Session {
  shopId: string;
  token: string;
}
interface FakeClient {
  session: Session;
  disposed: boolean;
  dispose(): void;
}

function memSessionStore(
  initial: Session | null,
): NizhalSessionStore<Session> & { saved: Session | null } {
  const state = { current: initial, saved: null as Session | null };
  return {
    get saved() {
      return state.saved;
    },
    async load() {
      return state.current;
    },
    async save(session) {
      state.current = session;
      state.saved = session;
    },
  };
}

function makeClient(session: Session): FakeClient {
  return { session, disposed: false, dispose() {} };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CACHED: Session = { shopId: "s1", token: "old" };
const FRESH: Session = { shopId: "s1", token: "new" };

describe("startLocalFirstBootstrap", () => {
  it("opens the local replica from cache immediately, then refreshes the session in the background", async () => {
    const store = memSessionStore(CACHED);
    const opens: FakeClient[] = [];
    startLocalFirstBootstrap<Session, FakeClient>({
      sessionStore: store,
      fetchSession: async () => FRESH,
      openStore: async (session) => makeClient(session),
      onOpen: (c) => opens.push(c),
    });

    await waitFor(() => opens.length === 1);
    expect(opens[0].session).toEqual(CACHED); // opened from cache, no network needed
    await waitFor(() => store.saved?.token === "new"); // background refresh re-cached the fresh session
    expect(opens).toHaveLength(1); // a cached open is not re-opened by the refresh
  });

  it("on a first-ever launch waits for the server, signals the wait, then opens", async () => {
    const store = memSessionStore(null);
    let attempts = 0;
    const required: boolean[] = [];
    const opens: FakeClient[] = [];
    startLocalFirstBootstrap<Session, FakeClient>({
      sessionStore: store,
      fetchSession: async () => {
        if (attempts++ < 1) throw new Error("server unreachable");
        return FRESH;
      },
      openStore: async (session) => makeClient(session),
      onOpen: (c) => opens.push(c),
      onConnectionRequired: (r) => required.push(r),
      retryDelayMs: 10,
    });

    await waitFor(() => opens.length === 1);
    expect(opens[0].session).toEqual(FRESH);
    expect(required).toContain(true); // it told the UI it was blocked
    expect(required.at(-1)).toBe(false); // and cleared it on open
  });

  it("disposing before the store finishes opening disposes the late client and never calls onOpen", async () => {
    let opened = false;
    let disposed = false;
    const boot = startLocalFirstBootstrap<Session, FakeClient>({
      sessionStore: memSessionStore(CACHED),
      fetchSession: async () => FRESH,
      openStore: async (session) => {
        await delay(30);
        return {
          session,
          disposed: false,
          dispose: () => {
            disposed = true;
          },
        };
      },
      onOpen: () => {
        opened = true;
      },
    });

    await delay(5); // let load() resolve and openStore begin (30ms in flight)
    boot.dispose(); // cancel while openStore is still in flight
    await delay(60);
    expect(opened).toBe(false);
    expect(disposed).toBe(true);
  });
});
