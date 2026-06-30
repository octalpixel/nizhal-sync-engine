import { type SyncRuleBuilder, type SyncRules, defineSyncRules } from "@nizhal/kernel";

function buildPosSyncRules(b: SyncRuleBuilder): SyncRules {
  return {
    myTerminal: b.bucket({
      parameters: () => b.params({ locationId: "location_id" }),
      data: (bucket) => [
        b.table("assets").where(b.eq("location_id", bucket.locationId)),
        b.table("stock_movements").where(b.eq("location_id", bucket.locationId)),
        b.table("stock_variances").where(b.eq("location_id", bucket.locationId)),
      ],
    }),
  } as unknown as SyncRules;
}

export const posSyncRules = defineSyncRules(buildPosSyncRules);
