import { type SyncRuleBuilder, type SyncRules, defineSyncRules } from "@nizhal/kernel";

// One bucket per branch. An actor's buckets are resolved server-side from `branch_members`:
//   SELECT branch_id AS ownerId FROM branch_members WHERE user_id = <actor.userId>
// A cashier has one membership row → one branch bucket. An owner has a row per branch → every branch
// bucket (HQ rollup). The SAME resolution gates pull AND writes, so a cashier physically cannot read
// or write another branch — the role boundary is engine-enforced, not app-trusted.
function buildChainSyncRules(b: SyncRuleBuilder): SyncRules {
  return {
    branch: b.bucket({
      parameters: (actor) =>
        b.membership({
          table: "branch_members",
          where: { user_id: actor.userId },
          select: { ownerId: "branch_id" },
        }),
      data: (bucket) => [
        b.table("products").where(b.eq("branch_id", bucket.ownerId)),
        b.table("sales").where(b.eq("branch_id", bucket.ownerId)),
        b.table("receipts").where(b.eq("branch_id", bucket.ownerId)),
      ],
    }),
  } as unknown as SyncRules;
}

export const chainSyncRules = defineSyncRules(buildChainSyncRules);
