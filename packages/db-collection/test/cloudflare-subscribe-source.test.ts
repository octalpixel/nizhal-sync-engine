import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudflareSubscribeSource } from "../src/index.js";

// createCloudflareSubscribeSource builds plain WebSockets via `new globalThis.WebSocket(url)`
// (the defaultWebSocketFactory). Stub the global so we can assert URLs + lifecycle deterministically,
// without a live workerd DO. This is the unit-level complement to the workerd e2e smoke (run-cf-e2e.sh),
// which exercises the server + a raw socket but not this source object.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown; isBinary?: boolean }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: string) {
    this.onmessage?.({ data });
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  static reset() {
    FakeWebSocket.instances = [];
  }
}

const flush = async () => {
  // resolve the async getUrl (getToken) promise chain that defers socket creation
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe("createCloudflareSubscribeSource", () => {
  let originalWS: unknown;
  beforeEach(() => {
    FakeWebSocket.reset();
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it("opens one partyserver WebSocket per bucket with the resolved async token in the URL", async () => {
    const source = createCloudflareSubscribeSource("127.0.0.1:8787", async () => "tok-123");
    source.subscribe(["shop-a", "shop b"], () => {});
    await flush();

    const urls = FakeWebSocket.instances.map((w) => w.url).sort();
    expect(urls).toEqual([
      "ws://127.0.0.1:8787/parties/nizhal-bucket/shop%20b?token=tok-123",
      "ws://127.0.0.1:8787/parties/nizhal-bucket/shop-a?token=tok-123",
    ]);
  });

  it("delivers string frames to onMessage and fires onReconnect on a re-open", async () => {
    const received: string[] = [];
    const onReconnect = vi.fn();
    const source = createCloudflareSubscribeSource(
      "https://realtime.example.com",
      async () => "t",
    );
    source.subscribe(["a"], (d) => received.push(d), onReconnect);
    await flush();

    const first = FakeWebSocket.instances[0];
    expect(first.url).toBe("wss://realtime.example.com/parties/nizhal-bucket/a?token=t");
    first.open();
    first.message("repull:a");
    expect(received).toEqual(["repull:a"]);
    expect(onReconnect).not.toHaveBeenCalled(); // first connect is not a reconnect

    first.serverClose();
    await vi.advanceTimersByTimeAsync(2000); // backoff reconnect
    await flush();
    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();
    second.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("uses an injected webSocketFactory (the React Native / native-transport seam)", async () => {
    let used = 0;
    const factory = (url: string) => {
      used += 1;
      return new FakeWebSocket(url) as unknown as WebSocket;
    };
    (globalThis as { WebSocket: unknown }).WebSocket = undefined; // prove the factory is used, not the global
    const source = createCloudflareSubscribeSource(
      "127.0.0.1:8787",
      async () => "t",
      undefined,
      factory,
    );
    source.subscribe(["a"], () => {});
    await flush();
    expect(used).toBe(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://127.0.0.1:8787/parties/nizhal-bucket/a?token=t");
  });

  it("unsubscribe closes every per-bucket socket and stops reconnecting", async () => {
    const source = createCloudflareSubscribeSource("127.0.0.1:8787", async () => "t");
    const unsub = source.subscribe(["a", "b"], () => {});
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    for (const w of FakeWebSocket.instances) w.open();

    unsub();
    for (const w of FakeWebSocket.instances) expect(w.closedWith).not.toBeNull();

    // a stray close after unsubscribe must not spawn a reconnect
    FakeWebSocket.instances[0].serverClose();
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
