import { PGlite } from "@electric-sql/pglite";
import { defineSyncRules } from "@nizhal/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";

const openDbs: PGlite[] = [];

describe("membership parameter queries", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("resolves bucket rows from a membership table with bound where values", async () => {
    const db = new PGlite();
    openDbs.push(db);
    const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
    await db.exec(
      "create table shop_members (user_id text not null, shop_id text not null, primary key (user_id, shop_id))",
    );
    await db.query("insert into shop_members (user_id, shop_id) values ($1, $2)", [
      "user-1",
      "shop-a",
    ]);
    await db.query("insert into shop_members (user_id, shop_id) values ($1, $2)", [
      "user-1",
      "shop-b",
    ]);
    await db.query("insert into shop_members (user_id, shop_id) values ($1, $2)", [
      "user-2",
      "shop-c",
    ]);

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

    if (!storage.getActorBuckets) throw new Error("storage adapter missing getActorBuckets");
    const buckets = await storage.getActorBuckets({
      actor: { userId: "user-1", ownerId: "owner-1" },
      syncRules: rules,
    });
    expect(buckets.sort()).toEqual(["shop-a", "shop-b"]);
  });

  it("treats a userId containing a quote as a literal bound value, not SQL injection", async () => {
    const db = new PGlite();
    openDbs.push(db);
    const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
    await db.exec(
      "create table shop_members (user_id text not null, shop_id text not null, primary key (user_id, shop_id))",
    );
    await db.query("insert into shop_members (user_id, shop_id) values ($1, $2)", [
      "user-1",
      "shop-a",
    ]);

    const maliciousUserId = "user-1' or '1'='1";
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

    if (!storage.getActorBuckets) throw new Error("storage adapter missing getActorBuckets");
    const buckets = await storage.getActorBuckets({
      actor: { userId: maliciousUserId, ownerId: "owner-1" },
      syncRules: rules,
    });
    expect(buckets).toEqual([]);
  });
});
