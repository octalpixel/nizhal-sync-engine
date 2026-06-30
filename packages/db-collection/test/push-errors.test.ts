import { NonRetriableError } from "@tanstack/offline-transactions";
import { describe, expect, it } from "vitest";
import { classifyPushError } from "../src/push-errors.js";
import { NizhalSyncTargetError } from "../src/sync-target.js";

// RFC-011 F-A — a user's write must be parked (terminal) ONLY on a definitively-terminal client error.
// Transient signals (timeout/conflict/rate-limit/5xx/network/cold-start) must retry, never park.
describe("classifyPushError (RFC-011 F-A)", () => {
  it("honors NizhalSyncTargetError.retriable", () => {
    expect(classifyPushError(new NizhalSyncTargetError("x", { retriable: true }))).toBe(
      "retriable",
    );
    expect(classifyPushError(new NizhalSyncTargetError("x", { retriable: false }))).toBe(
      "terminal",
    );
  });

  it("treats NonRetriableError as terminal", () => {
    expect(classifyPushError(new NonRetriableError("nope"))).toBe("terminal");
  });

  it("treats network / connectivity / timeout failures as retriable", () => {
    for (const m of [
      "fetch failed",
      "ECONNRESET",
      "ETIMEDOUT",
      "socket hang up",
      "network error",
      "The operation timed out",
      "request aborted",
    ]) {
      expect(classifyPushError(new Error(m))).toBe("retriable");
    }
  });

  it("RETRIES transient HTTP statuses (the F-A fix: 408/409/425/429/5xx never park)", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(classifyPushError(new Error(`push failed: ${status} upstream`))).toBe("retriable");
    }
  });

  it("PARKS only definitively-terminal client errors", () => {
    for (const status of [400, 401, 403, 404, 405, 422]) {
      expect(classifyPushError(new Error(`push failed: ${status} bad request`))).toBe("terminal");
    }
  });

  it("parses the status from the prefix only — a body digit must not park the write", () => {
    // a 503 whose body text happens to contain "400" must stay retriable (old loose regex parked it)
    expect(
      classifyPushError(new Error('push failed: 503 {"error":"saw 400 upstream earlier"}')),
    ).toBe("retriable");
  });

  it("defaults unknown shapes to retriable (never silently park)", () => {
    expect(classifyPushError(new Error("something weird happened"))).toBe("retriable");
    expect(classifyPushError("a plain string")).toBe("retriable");
    expect(classifyPushError({ weird: true })).toBe("retriable");
  });
});
