import { type SyncRuleBuilder, type SyncRules, defineSyncRules } from "@nizhal/kernel";

function buildTabkeepSyncRules(b: SyncRuleBuilder): SyncRules {
  return {
    myShop: b.bucket({
      parameters: () => b.params({ ownerId: "shop_id" }),
      data: (bucket) => [
        b.table("customers").where(b.eq("shop_id", bucket.ownerId)),
        b.table("ledger_entries").where(b.eq("shop_id", bucket.ownerId)),
      ],
    }),
  } as unknown as SyncRules;
}

export const tabkeepSyncRules = defineSyncRules(buildTabkeepSyncRules);
