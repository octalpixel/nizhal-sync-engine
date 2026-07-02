import { describe, expect, it, vi } from "vitest";
import { manualOnlineDetector } from "../src/index.js";
import type { OnlineDetector } from "../src/index.js";

describe("manualOnlineDetector", () => {
  it("is online by default and forces offline / back online on demand", () => {
    const d = manualOnlineDetector();
    expect(d.isOnline()).toBe(true);
    d.setOnline(false);
    expect(d.isOnline()).toBe(false);
    expect(d.isForcedOffline()).toBe(true);
    d.setOnline(true);
    expect(d.isOnline()).toBe(true);
    expect(d.isForcedOffline()).toBe(false);
  });

  it("notifies subscribers (flush trigger) when released back online, not when forced offline", () => {
    const d = manualOnlineDetector();
    const cb = vi.fn();
    d.subscribe(cb);
    d.setOnline(false);
    expect(cb).not.toHaveBeenCalled(); // going offline must not trigger a flush
    d.setOnline(true);
    expect(cb).toHaveBeenCalledTimes(1); // reconnect → flush
  });

  it("follows the base detector unless an offline override is active", () => {
    let baseOnline = true;
    const base: OnlineDetector = {
      isOnline: () => baseOnline,
      subscribe: () => () => {},
      notifyOnline: () => {},
      dispose: () => {},
    };
    const d = manualOnlineDetector(base);
    expect(d.isOnline()).toBe(true);
    baseOnline = false;
    expect(d.isOnline()).toBe(false); // follows base
    baseOnline = true;
    d.setOnline(false);
    expect(d.isOnline()).toBe(false); // override wins over base-online
  });
});
