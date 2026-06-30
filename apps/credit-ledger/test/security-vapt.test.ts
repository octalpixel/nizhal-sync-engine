import { PGlite } from "@electric-sql/pglite";
import { createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { creditLedgerMutators } from "../src/mutators.js";
import { CREDIT_LEDGER_DDL, creditLedgerSchema } from "../src/schema.js";
import { creditLedgerSyncRules } from "../src/sync-rules.js";

const openDbs: PGlite[] = [];

describe("credit-ledger tenant write VAPT", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("rejects every foreign-id customer update/delete while preserving same-shop writes", async () => {
    const { db, server } = await createHarness();

    const name = await push(server, "updateCustomerName", {
      customerId: "shop-b-name",
      value: "PWNED",
    });
    const phone = await push(server, "updateCustomerPhone", {
      customerId: "shop-b-phone",
      value: "PWNED",
    });
    const remove = await push(server, "deleteCustomer", { customerId: "shop-b-delete" });
    const own = await push(server, "updateCustomerName", {
      customerId: "shop-a-customer",
      value: "Allowed",
    });

    expect([name.status, phone.status, remove.status].every((status) => status >= 400)).toBe(true);
    expect(own.status, await own.clone().text()).toBe(200);
    const rows = await db.query<{ id: string; name: string; phone: string | null }>(
      "select id, name, phone from customers order by id",
    );
    expect(rows.rows).toEqual([
      { id: "shop-a-customer", name: "Allowed", phone: "111" },
      { id: "shop-b-delete", name: "Delete Safe", phone: "444" },
      { id: "shop-b-name", name: "Name Safe", phone: "222" },
      { id: "shop-b-phone", name: "Phone Safe", phone: "333" },
    ]);
  });
});

async function createHarness() {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await db.exec(CREDIT_LEDGER_DDL);
  await storage.provision({ schema: creditLedgerSchema, syncRules: creditLedgerSyncRules });
  await db.exec(`
    insert into shops (id, name, owner_id) values ('shop-a', 'A', 'owner-a'), ('shop-b', 'B', 'owner-b');
    insert into shop_members (shop_id, user_id, role) values ('shop-a', 'user-a', 'owner');
    insert into customers (id, shop_id, name, phone) values
      ('shop-a-customer', 'shop-a', 'Own', '111'),
      ('shop-b-name', 'shop-b', 'Name Safe', '222'),
      ('shop-b-phone', 'shop-b', 'Phone Safe', '333'),
      ('shop-b-delete', 'shop-b', 'Delete Safe', '444');
  `);
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: creditLedgerSchema,
    syncRules: creditLedgerSyncRules,
    mutators: creditLedgerMutators,
    storage,
    auth: {
      async resolve() {
        return { userId: "user-a", ownerId: "owner-a", shopId: "shop-a" };
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
