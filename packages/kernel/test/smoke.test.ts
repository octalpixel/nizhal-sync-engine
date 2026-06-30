import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SyncRuleLintError,
  defineMutator,
  defineMutators,
  defineSyncRules,
  emitNizhalContract,
} from "../src/index.js";

describe("@nizhal/kernel", () => {
  it("defineMutators assigns each mutator its map-key name", () => {
    const m = defineMutators({
      ringSale: defineMutator({ parse: (x) => x as unknown }, async () => {}),
    });
    expect(m.ringSale.name).toBe("ringSale");
  });

  it("defineSyncRules preserves the rule set", () => {
    const r = defineSyncRules({ myBucket: { parameters: () => ({}), data: () => [] } });
    expect(Object.keys(r)).toEqual(["myBucket"]);
  });

  it("rejects a data query that is not bucket scoped", () => {
    expect(() =>
      defineSyncRules((b) => ({
        myBucket: b.bucket({
          parameters: () => b.params({ shopId: "shop_id" }),
          data: () => [
            b.raw("select * from ledger_entries", { table: "ledger_entries", bucketScopes: [] }),
          ],
        }),
      })),
    ).toThrow(SyncRuleLintError);
  });

  it("emits an OpenAPI contract from rows, mutator inputs, and sync rule names", () => {
    const syncRules = defineSyncRules((b) => ({
      myBucket: b.bucket({
        parameters: () => b.params({ shopId: "shop_id" }),
        data: (bucket) => [b.table("ledger_entries").where(b.eq("shop_id", bucket.shopId))],
      }),
    }));
    const mutators = defineMutators({
      addEntry: defineMutator(z.object({ shopId: z.string(), amount: z.number() }), async () => {}),
    });
    const contract = emitNizhalContract({
      title: "Test Nizhal",
      version: "1.2.3",
      schema: {
        ledger_entries: z.object({ id: z.string(), shopId: z.string(), amount: z.number() }),
      },
      mutators,
      syncRules,
    });

    expect(contract.openapi).toBe("3.1.0");
    expect(contract.info).toEqual({ title: "Test Nizhal", version: "1.2.3" });
    expect(contract["x-echo"].collections).toEqual(["ledger_entries"]);
    expect(contract["x-echo"].syncRules).toEqual(["myBucket"]);
    expect(contract["x-echo"].mutators.addEntry.input).toEqual({
      $ref: "#/components/schemas/AddEntryInput",
    });
    expect(contract.components.schemas.LedgerEntries).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        shopId: { type: "string" },
        amount: { type: "number" },
      },
    });
  });
});
