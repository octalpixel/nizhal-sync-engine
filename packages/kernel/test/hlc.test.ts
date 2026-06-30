import { describe, expect, it } from "vitest";
import { formatHlc, normalizeHlcNodeId, parseHlc } from "../src/hlc.js";

describe("HLC nodeId width (D2)", () => {
  it("does not collide two nodeIds that share their low 64 bits", () => {
    // Two distinct 128-bit ids with identical low 64 bits — truncating to 64 bits would alias them
    // and make field-merge pick the wrong winner (a silently-lost edit).
    const a = "aaaaaaaaaaaaaaaaffffffffffffffff";
    const b = "bbbbbbbbbbbbbbbbffffffffffffffff";
    expect(normalizeHlcNodeId(a)).not.toBe(normalizeHlcNodeId(b));
  });

  it("round-trips a full 128-bit (UUID) nodeId through format/parse", () => {
    const nodeId = "0123456789abcdef0123456789abcdef";
    const formatted = formatHlc({ wallTime: Date.UTC(2026, 0, 1), counter: 3, nodeId });
    expect(parseHlc(formatted).nodeId).toBe(nodeId);
  });

  it("normalizes a dashed UUID to its full hex", () => {
    expect(normalizeHlcNodeId("0123456789ab-cdef-0123-4567-89abcdef0000")).toBe(
      "0123456789abcdef0123456789abcdef0000".slice(-32),
    );
  });
});
