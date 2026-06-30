import { describe, expect, it } from "vitest";
import {
  MUTATION_ID_KEY,
  allocateMutationId,
  nextMutationIdFrom,
  readAllocatedMutationId,
  readPersistedMutationId,
  writeAllocatedMutationId,
  writePersistedMutationId,
} from "../src/mutation-id.js";

function memKv() {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k: string) => map.get(k),
    set: async (k: string, v: string) => void map.set(k, v),
  };
}

describe("mutation-id sequencing", () => {
  it("continues from the highest of persisted high-water and pending outbox ids", () => {
    expect(nextMutationIdFrom(0, [])).toBe(1); // fresh client
    expect(nextMutationIdFrom(2, [])).toBe(3); // restart with persisted high-water
    expect(nextMutationIdFrom(0, [1, 2])).toBe(3); // crash window: ids durable in outbox, high-water lagged
    expect(nextMutationIdFrom(5, [3])).toBe(6); // persisted wins
  });

  it("rejects corrupt/unsafe values instead of producing a fractional or stuck id", async () => {
    expect(nextMutationIdFrom(1.5, [])).toBe(1); // fractional persisted → ignored, not 2.5
    expect(nextMutationIdFrom(0, [2.5, 3])).toBe(4); // fractional pending → ignored
    expect(nextMutationIdFrom(-5, [])).toBe(1); // negative → ignored
    expect(nextMutationIdFrom(Number.NaN, [])).toBe(1);
    expect(() => nextMutationIdFrom(Number.MAX_SAFE_INTEGER, [])).toThrow(/exhausted/); // no silent stop
    const kv = memKv();
    kv.map.set(MUTATION_ID_KEY, "1.5");
    expect(await readPersistedMutationId(kv)).toBe(0); // corrupt persisted value ignored
    kv.map.set(MUTATION_ID_KEY, "not-a-number");
    expect(await readPersistedMutationId(kv)).toBe(0);
  });

  it("round-trips the high-water through storage (survives a 'restart')", async () => {
    const kv = memKv();
    expect(await readPersistedMutationId(kv)).toBe(0);
    await writePersistedMutationId(kv, 7);
    expect(kv.map.get(MUTATION_ID_KEY)).toBe("7");
    // a fresh reader (new session) sees the persisted value
    expect(await readPersistedMutationId({ get: kv.get, set: kv.set })).toBe(7);
    expect(nextMutationIdFrom(await readPersistedMutationId(kv), [])).toBe(8);
  });

  it("allocates above server, local, and pending high-waters and durably keys each transaction", async () => {
    expect(allocateMutationId(7, 3, [5])).toBe(8);
    expect(allocateMutationId(2, 7, [6])).toBe(8);
    expect(allocateMutationId(2, 3, [7])).toBe(8);

    const kv = memKv();
    await writeAllocatedMutationId(kv, "tx-1", 8);
    await writeAllocatedMutationId(kv, "tx-2", 9);
    expect(await readAllocatedMutationId(kv, "tx-1")).toBe(8);
    expect(await readAllocatedMutationId(kv, "tx-2")).toBe(9);
    expect(await readAllocatedMutationId(kv, "unknown")).toBe(0);
  });
});
