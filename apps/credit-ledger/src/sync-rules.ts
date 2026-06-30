import { type SyncRuleBuilder, type SyncRules, defineSyncRules } from "@nizhal/kernel";

function buildCreditLedgerSyncRules(b: SyncRuleBuilder): SyncRules {
  return {
    myShops: b.bucket({
      parameters: (actor) =>
        b.membership({
          table: "shop_members",
          where: { user_id: actor.userId },
          select: { shopId: "shop_id" },
        }),
      data: (bucket) => [
        b.table("customers").where(b.eq("shop_id", bucket.shopId)),
        b.table("ledger_entries").where(b.eq("shop_id", bucket.shopId)),
        b.table("reminders").where(b.eq("shop_id", bucket.shopId)),
      ],
    }),
  } as unknown as SyncRules;
}

export const creditLedgerSyncRules = defineSyncRules(buildCreditLedgerSyncRules);
