import { createNizhalClient, manualOnlineDetector, openNizhalStore } from "@nizhal/db-collection";
import { waSqliteChanges, waSqliteDrizzle } from "@nizhal/local/wa-sqlite";
import { desc } from "drizzle-orm";
import * as SQLite from "wa-sqlite";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";
import { restSyncTarget } from "./adapter.js";
import { orders, posMutators, posSyncRules, products } from "./domain.js";

const SERVER = "http://127.0.0.1:4600";
const schema = { products, orders };

async function boot() {
  // browser SQLite (docs/platforms.md — Vite recipe)
  const sqliteModule = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  const sqlite3 = SQLite.Factory(sqliteModule);
  const vfs = new IDBBatchAtomicVFS("pos-vfs");
  sqlite3.vfs_register(vfs, true);
  const database = await sqlite3.open_v2(
    "pos.db",
    SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
    vfs.name,
  );

  // ★ B2: the client is stock Nizhal — only the transport is the REST adapter.
  const onlineDetector = manualOnlineDetector();
  const echo = createNizhalClient({
    syncTarget: restSyncTarget(SERVER),
    bucketsForSyncRule: () => ["shop-1"],
    pull: { intervalMs: 2000 }, // no websocket on the existing API → interval pull
  });
  const store = await openNizhalStore({
    echo,
    schema,
    syncRules: posSyncRules,
    mutators: posMutators,
    actor: { userId: "till-1", ownerId: "shop-1" },
    database: waSqliteDrizzle({ sqlite3, database, config: { schema } }),
    changes: waSqliteChanges(sqlite3, database),
    crossTabChannel: "pos", // multi-tab: sibling tabs' watchers re-run when this tab writes
    onlineDetector,
  });
  (globalThis as Record<string, unknown>).__pos = store; // dev/E2E handle

  const el = {
    status: document.querySelector("#status") as HTMLParagraphElement,
    products: document.querySelector("#products") as HTMLUListElement,
    orders: document.querySelector("#orders") as HTMLParagraphElement,
    toggle: document.querySelector("#toggle") as HTMLButtonElement,
  };

  let online = true;
  el.toggle.addEventListener("click", () => {
    online = !online;
    onlineDetector.setOnline(online);
    el.toggle.textContent = online ? "● Online" : "○ Offline";
    void refreshPending();
  });

  async function refreshPending() {
    el.status.textContent = `${await store.getPendingCount()} queued sale(s) in the outbox`;
  }

  const t = store.tables;
  store.watch(
    store.db
      .select()
      .from(t.products)
      .orderBy(t.products.name as never),
    ({ data, error }) => {
      if (error) {
        el.status.textContent = `error: ${error.message}`;
        return;
      }
      el.products.replaceChildren(
        ...(data ?? []).map((product) => {
          const row = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = `${product.name} — $${(product.price_cents / 100).toFixed(2)} · stock ${product.stock}`;
          const sell = document.createElement("button");
          sell.textContent = "Sell 1";
          sell.addEventListener("click", async () => {
            store.mutate.recordSale({
              id: crypto.randomUUID(),
              productId: product.id,
              quantity: 1,
              priceCents: product.price_cents,
            });
            await refreshPending();
          });
          row.append(label, sell);
          return row;
        }),
      );
    },
  );

  store.watch(
    store.db
      .select()
      .from(t.orders)
      .orderBy(desc(t.orders.created_at as never)),
    ({ data }) => {
      el.orders.textContent = `${data?.length ?? 0} order(s) locally — total $${(
        (data ?? []).reduce((sum, order) => sum + order.total_cents, 0) / 100
      ).toFixed(2)}`;
      void refreshPending();
    },
  );

  await store.ready();
  void refreshPending();
}

void boot();
