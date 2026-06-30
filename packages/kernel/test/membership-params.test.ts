import { describe, expect, it } from "vitest";
import { defineSyncRules } from "../src/index.js";

describe("sync-rule membership parameters", () => {
  it("builds an echo-membership descriptor with bucket column mapping", () => {
    const rules = defineSyncRules((b) => ({
      myShops: b.bucket({
        parameters: (actor) =>
          b.membership({
            table: "shop_members",
            where: { user_id: actor.userId },
            select: { shopId: "shop_id" },
          }),
        data: (bucket) => [b.table("customers").where(b.eq("shop_id", bucket.shopId))],
      }),
    }));

    const parameters = rules.myShops.parameters({ userId: "user-1", ownerId: "owner-1" });
    expect(parameters).toEqual({
      kind: "echo-membership",
      table: "shop_members",
      where: { user_id: "user-1" },
      bucketColumns: { shopId: "shop_id" },
    });
    expect(rules.myShops.bucketColumns).toEqual(["shopId"]);
  });
});
