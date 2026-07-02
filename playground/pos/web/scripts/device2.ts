import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNizhalClient, manualOnlineDetector, openNizhalStore } from "@nizhal/db-collection";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { restSyncTarget } from "../src/adapter.js";
import { orders, posMutators, posSyncRules, products } from "../src/domain.js";

// A SECOND DEVICE, headless: the same stock store + the same REST adapter, its own SQLite file
// and its own clientID — exactly what another till/phone would be. Usage:
//   pnpm --filter pos-web exec tsx scripts/device2.ts [sell <productId>]
const SERVER = process.env.POS_SERVER ?? "http://127.0.0.1:4600";
const schema = { products, orders };

async function main() {
  const file =
    process.env.DEVICE2_DB ?? join(mkdtempSync(join(tmpdir(), "pos-device2-")), "till2.db");
  const sqlite = new Database(file);
  const store = await openNizhalStore({
    echo: createNizhalClient({
      syncTarget: restSyncTarget(SERVER),
      bucketsForSyncRule: () => ["shop-1"],
    }),
    schema,
    syncRules: posSyncRules,
    mutators: posMutators,
    actor: { userId: "till-2", ownerId: "shop-1" },
    database: drizzle(sqlite),
    onlineDetector: manualOnlineDetector(),
  });
  await store.ready();

  const productRows = await store.db.select().from(store.tables.products);
  console.log(
    "[device2] products:",
    productRows.map((p) => `${p.name}(stock ${p.stock})`).join(", "),
  );

  const [, , command, productId] = process.argv;
  if (command === "sell" && productId) {
    const product = productRows.find((p) => p.id === productId);
    if (!product) throw new Error(`unknown product ${productId}`);
    store.mutate.recordSale({
      id: crypto.randomUUID(),
      productId,
      quantity: 1,
      priceCents: product.price_cents,
    });
    await store.waitForIdle();
    console.log(`[device2] sold 1 ${product.name}; pending=${await store.getPendingCount()}`);
  }

  await store.pullNow();
  const orderRows = await store.db.select().from(store.tables.orders);
  console.log(`[device2] sees ${orderRows.length} order(s) after pull`);
  await store.dispose();
  sqlite.close();
}

void main();
