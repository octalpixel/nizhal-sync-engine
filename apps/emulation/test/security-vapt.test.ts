import { PGlite } from "@electric-sql/pglite";
import { createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { posMutators } from "../src/pos/mutators.js";
import { POS_DDL, posSchema } from "../src/pos/schema.js";
import { posSyncRules } from "../src/pos/sync-rules.js";

const openDbs: PGlite[] = [];

describe("playground POS tenant write VAPT", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("rejects every foreign-id asset update while preserving same-location writes", async () => {
    const { db, server } = await createHarness();

    const name = await push(server, "updateProductName", {
      assetId: "location-b-name",
      value: "PWNED",
    });
    const sku = await push(server, "updateProductSku", {
      assetId: "location-b-sku",
      value: "PWNED",
    });
    const own = await push(server, "updateProductName", {
      assetId: "location-a-asset",
      value: "Allowed",
    });

    expect([name.status, sku.status].every((status) => status >= 400)).toBe(true);
    expect(own.status, await own.clone().text()).toBe(200);
    const rows = await db.query<{ id: string; name: string; sku: string | null }>(
      "select id, name, sku from assets order by id",
    );
    expect(rows.rows).toEqual([
      { id: "location-a-asset", name: "Allowed", sku: "A" },
      { id: "location-b-name", name: "Name Safe", sku: "B1" },
      { id: "location-b-sku", name: "Sku Safe", sku: "B2" },
    ]);
  });
});

async function createHarness() {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await db.exec(POS_DDL);
  await storage.provision({ schema: posSchema, syncRules: posSyncRules });
  await db.exec(`
    insert into locations (id, owner_id, name) values
      ('location-a', 'owner-a', 'A'), ('location-b', 'owner-b', 'B');
    insert into assets (id, location_id, name, sku) values
      ('location-a-asset', 'location-a', 'Own', 'A'),
      ('location-b-name', 'location-b', 'Name Safe', 'B1'),
      ('location-b-sku', 'location-b', 'Sku Safe', 'B2');
  `);
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: posSchema,
    syncRules: posSyncRules,
    mutators: posMutators,
    storage,
    auth: {
      async resolve() {
        return { userId: "user-a", ownerId: "owner-a", locationId: "location-a" };
      },
    },
  });
  return { db, server };
}

function push(
  server: Awaited<ReturnType<typeof createHarness>>["server"],
  name: string,
  args: unknown,
) {
  return server.app.request("/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mutations: [{ name, args, clientMutationId: `${name}-${JSON.stringify(args)}` }],
    }),
  });
}
