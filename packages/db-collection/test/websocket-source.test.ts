import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WebSocketLike,
  createWebSocketSource,
} from "../src/websocket-source.js";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown; isBinary?: boolean }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly headers?: Record<string, string>,
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.closedWith = { code, reason };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }
  // test helpers
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  message(data: string) {
    this.onmessage?.({ data });
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  static last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
  static reset() {
    FakeWebSocket.instances = [];
  }
}

const factory = (url: string, protocols?: string | string[], headers?: Record<string, string>) =>
  new FakeWebSocket(url, protocols, headers);

describe("createWebSocketSource", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // deterministic jitter (lower bound)
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects, builds the URL from buckets, and delivers string frames to onMessage", () => {
    const source = createWebSocketSource({
      getUrl: (buckets) => `wss://x/stream?b=${buckets.join(",")}`,
      webSocketFactory: factory,
    });
    const received: string[] = [];
    source.subscribe(["a", "b"], (d) => received.push(d));

    const ws = FakeWebSocket.last();
    expect(ws.url).toBe("wss://x/stream?b=a,b");
    ws.open();
    ws.message("hello");
    expect(received).toEqual(["hello"]);
  });

  it("re-evaluates getUrl and getHeaders on every reconnect (no stale token)", () => {
    let token = "t1";
    const source = createWebSocketSource({
      getUrl: () => `wss://x/stream?token=${token}`,
      getHeaders: () => ({ authorization: `Bearer ${token}` }),
      webSocketFactory: factory,
    });
    source.subscribe(["a"], () => {});

    const first = FakeWebSocket.last();
    first.open(); // stable connection
    token = "t2"; // token rotates while connected
    first.serverClose(); // drop

    vi.runOnlyPendingTimers(); // fire the backoff timer → reconnect
    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);
    expect(second.url).toBe("wss://x/stream?token=t2");
    expect(second.headers?.authorization).toBe("Bearer t2");
  });

  it("calls onReconnect (not on first open) for catch-up pull", () => {
    const onReconnect = vi.fn();
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
    });
    source.subscribe(["a"], () => {}, onReconnect);

    FakeWebSocket.last().open();
    expect(onReconnect).not.toHaveBeenCalled(); // first connect
    FakeWebSocket.last().serverClose();
    vi.runOnlyPendingTimers();
    FakeWebSocket.last().open();
    expect(onReconnect).toHaveBeenCalledTimes(1); // reconnect
  });

  it("stability gate: accept-then-immediate-close grows the backoff (no hot loop)", () => {
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
      reconnect: { minDelayMs: 1000, growthFactor: 2, minUptimeMs: 5000 },
    });
    source.subscribe(["a"], () => {});

    // Open then close immediately, three times — never stable for minUptime.
    for (let i = 0; i < 3; i += 1) {
      const ws = FakeWebSocket.last();
      ws.open();
      ws.serverClose(); // closes well before the 5s stability gate
      vi.runOnlyPendingTimers();
    }
    // retryCount kept climbing because the counter never reset → 4th socket exists.
    expect(FakeWebSocket.instances.length).toBe(4);
  });

  it("connect timeout: aborts and retries a socket that never opens", () => {
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
      reconnect: { connectTimeoutMs: 4000, minDelayMs: 1000 },
    });
    source.subscribe(["a"], () => {});
    const first = FakeWebSocket.last();

    vi.advanceTimersByTime(4000); // connect timeout fires (never opened)
    expect(first.closedWith).not.toBeNull();
    vi.runOnlyPendingTimers(); // backoff → new socket
    expect(FakeWebSocket.last()).not.toBe(first);
  });

  it("heartbeat: pings when idle and reconnects on a missed pong", () => {
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
      heartbeat: { intervalMs: 25000, timeoutMs: 10000, message: "ping" },
    });
    source.subscribe(["a"], () => {});
    const ws = FakeWebSocket.last();
    ws.open();

    vi.advanceTimersByTime(25000); // heartbeat interval → ping sent
    expect(ws.sent).toContain("ping");
    vi.advanceTimersByTime(10000); // no pong → force close
    expect(ws.closedWith?.code).toBe(4000);
  });

  it("heartbeat: a pong frame is liveness only (not delivered) and resets the timeout", () => {
    const received: string[] = [];
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
      heartbeat: { intervalMs: 25000, timeoutMs: 10000 },
    });
    source.subscribe(["a"], (d) => received.push(d));
    const ws = FakeWebSocket.last();
    ws.open();

    vi.advanceTimersByTime(25000); // ping
    ws.message("pong"); // pong before timeout
    vi.advanceTimersByTime(10000); // would have closed without the pong
    expect(ws.closedWith).toBeNull();
    expect(received).not.toContain("pong");
  });

  it("onConnectFailure: invoked on close-before-open; false stops retrying", async () => {
    const onConnectFailure = vi.fn().mockResolvedValue(false);
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
      onConnectFailure,
    });
    source.subscribe(["a"], () => {});

    FakeWebSocket.last().serverClose(1008); // never opened
    await vi.runOnlyPendingTimersAsync();
    expect(onConnectFailure).toHaveBeenCalledTimes(1);
    // false → no further socket created
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("online detector: reconnects immediately when connectivity returns", () => {
    let online = true;
    const listeners = new Set<() => void>();
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
      onlineDetector: {
        isOnline: () => online,
        subscribe: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        notifyOnline: () => {},
        dispose: () => {},
      },
    });
    source.subscribe(["a"], () => {});
    FakeWebSocket.last().open();

    online = false;
    FakeWebSocket.last().serverClose(); // drop while offline → no reconnect scheduled
    const countAfterDrop = FakeWebSocket.instances.length;
    vi.runOnlyPendingTimers();
    expect(FakeWebSocket.instances.length).toBe(countAfterDrop); // still offline, no retry

    online = true;
    for (const cb of listeners) cb(); // network back
    expect(FakeWebSocket.instances.length).toBe(countAfterDrop + 1); // reconnected now
  });

  it("unsubscribe closes the socket and stops reconnecting", () => {
    const source = createWebSocketSource({
      getUrl: () => "wss://x",
      webSocketFactory: factory,
    });
    const unsub = source.subscribe(["a"], () => {});
    const ws = FakeWebSocket.last();
    ws.open();
    unsub();
    expect(ws.closedWith).not.toBeNull();
    ws.serverClose();
    vi.runOnlyPendingTimers();
    expect(FakeWebSocket.instances.length).toBe(1); // no reconnect after unsubscribe
  });
});
