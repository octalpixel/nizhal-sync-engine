import { describe, expect, it } from "vitest";
import { foldLedgerBalance, formatMinorUnits, parseMinorUnits } from "../src/client.js";
import type { LedgerEntryRow } from "../src/schema.js";

const baseEntry = {
  shop_id: "shop-1",
  customer_id: "customer-1",
  note: null,
  created_at: new Date("2026-06-28T00:00:00.000Z"),
  updated_at: new Date("2026-06-28T00:00:00.000Z"),
  deleted_at: null,
};

describe("Tabkeep ledger", () => {
  it("folds append-only integer movements", () => {
    const entries: LedgerEntryRow[] = [
      { ...baseEntry, id: "credit", kind: "credit", amount: 10_001 },
      { ...baseEntry, id: "payment", kind: "payment", amount: 3_333 },
    ];
    expect(foldLedgerBalance(entries, "customer-1")).toBe(6_668);
  });

  it("parses and formats money without float arithmetic", () => {
    expect(parseMinorUnits("1000.01")).toBe(100_001);
    expect(formatMinorUnits(100_001)).toBe("Rs 1,000.01");
    expect(() => parseMinorUnits("1.001")).toThrow(/at most two decimal/);
  });
});
