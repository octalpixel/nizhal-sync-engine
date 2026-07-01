import { defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { createNizhalClient } from "../src/client.js";
import { openNizhalCollectionsStore as openNizhalStore } from "../src/store.js";

const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  name: text("name").notNull(),
});
const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  amount: text("amount").notNull(),
});
const orphan = pgTable("orphan", { id: text("id").primaryKey() });

const syncRules = defineSyncRules((b) => ({
  myShop: b.bucket({
    parameters: () => b.params({ ownerId: "shop_id" }),
    data: (bucket) => [
      b.table("customers").where(b.eq("shop_id", bucket.ownerId)),
      b.table("ledger_entries").where(b.eq("shop_id", bucket.ownerId)),
    ],
  }),
}));

const mutators = defineMutators({
  addCustomer: defineMutator(
    { parse: (v) => v as { id: string; name: string } },
    async ({ tx, ownerId }, args) => {
      await tx.insert(customers).values({ id: args.id, shop_id: ownerId, name: args.name });
      return { serverId: args.id, affectedBuckets: [ownerId] };
    },
  ),
  renameCustomer: defineMutator(
    { parse: (v) => v as { id: string; name: string } },
    async ({ tx, ownerId }, args) => {
      await tx.update(customers, { id: args.id }).set({ name: args.name });
      return { serverId: args.id, affectedBuckets: [ownerId] };
    },
  ),
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("openNizhalStore", () => {
  it("derives one collection per synced table (keyed by schema export name) and flows mutations", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const echo = createNizhalClient({});
    const store = await openNizhalStore({
      echo,
      schema: { customers, ledgerEntries },
      syncRules,
      mutators,
      actor: { userId: "u1", ownerId: "shop-1" },
    });

    expect(Object.keys(store.collections).sort()).toEqual(["customers", "ledgerEntries"]);

    store.mutate.addCustomer({ id: "c1", name: "Alice" });
    await waitFor(() => store.collections.customers.get("c1")?.name === "Alice");
    expect(store.collections.customers.get("c1")).toMatchObject({
      shop_id: "shop-1",
      name: "Alice",
    });

    store.mutate.renameCustomer({ id: "c1", name: "Alicia" });
    await waitFor(() => store.collections.customers.get("c1")?.name === "Alicia");

    await store.dispose();
    vi.unstubAllGlobals();
  });

  it("rejects a schema table that no sync rule covers", async () => {
    const echo = createNizhalClient({});
    await expect(
      openNizhalStore({
        echo,
        schema: { customers, orphan },
        syncRules,
        mutators,
        actor: { userId: "u1", ownerId: "shop-1" },
      }),
    ).rejects.toThrow(/no sync rule/);
  });
});
