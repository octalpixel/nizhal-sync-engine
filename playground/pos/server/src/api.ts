import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The "EXISTING BACKEND" for the brownfield-B2 demo: a perfectly ordinary Hono + SQLite REST
// API that knows NOTHING about Nizhal. The offline POS client syncs against it through a
// custom NizhalSyncTarget adapter (playground/pos/web/src/adapter.ts).
//
// Sections marked [SYNC ADDITION] are the honest "WatermelonDB tax" — the minimal things a
// backend team adds so offline clients can sync: a monotonic change cursor, tombstones for
// deletes, and idempotent writes keyed by the client's mutation id. Everything else is the
// API they already had.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const db = new Database(process.env.POS_DB ?? "pos-existing.db");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL DEFAULT 'shop-1',
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    server_seq INTEGER NOT NULL DEFAULT 0            -- [SYNC ADDITION] change cursor position
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL DEFAULT 'shop-1',
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    server_seq INTEGER NOT NULL DEFAULT 0            -- [SYNC ADDITION]
  );
  -- [SYNC ADDITION] deletes must survive for offline clients that weren't around to see them
  CREATE TABLE IF NOT EXISTS tombstones (
    tbl TEXT NOT NULL,
    id TEXT NOT NULL,
    server_seq INTEGER NOT NULL,
    PRIMARY KEY (tbl, id)
  );
  -- [SYNC ADDITION] idempotency: replayed client mutations must not double-apply
  CREATE TABLE IF NOT EXISTS processed_mutations (
    client_mutation_id TEXT PRIMARY KEY,
    result TEXT NOT NULL
  );
  -- [SYNC ADDITION] the monotonic cursor source (SQLite: a one-row counter is plenty)
  CREATE TABLE IF NOT EXISTS change_seq (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
  INSERT OR IGNORE INTO change_seq (id, seq) VALUES (1, 0);
`);

// [SYNC ADDITION] every write bumps the global cursor and stamps the row
function nextSeq(): number {
  db.prepare("UPDATE change_seq SET seq = seq + 1 WHERE id = 1").run();
  return (db.prepare("SELECT seq FROM change_seq WHERE id = 1").get() as { seq: number }).seq;
}

const app = new Hono();
app.use("*", cors());

// ── the API they already had ────────────────────────────────────────────────────────────────
app.get("/products", (c) => c.json(db.prepare("SELECT * FROM products").all()));

app.post("/products", async (c) => {
  const body = (await c.req.json()) as {
    id: string;
    name: string;
    priceCents: number;
    stock: number;
  };
  db.prepare(
    "INSERT OR REPLACE INTO products (id, shop_id, name, price_cents, stock, server_seq) VALUES (?, 'shop-1', ?, ?, ?, ?)",
  ).run(body.id, body.name, body.priceCents, body.stock, nextSeq());
  return c.json({ ok: true });
});

app.delete("/products/:id", (c) => {
  const id = c.req.param("id");
  db.prepare("DELETE FROM products WHERE id = ?").run(id);
  db.prepare(
    "INSERT OR REPLACE INTO tombstones (tbl, id, server_seq) VALUES ('products', ?, ?)",
  ).run(id, nextSeq()); // [SYNC ADDITION]
  return c.json({ ok: true });
});

app.post("/orders", async (c) => {
  const body = (await c.req.json()) as {
    id: string;
    productId: string;
    quantity: number;
    totalCents: number;
  };
  // [SYNC ADDITION] idempotency by the client's mutation id — a retried push must not
  // double-sell. This is the ONE discipline the existing endpoint takes on.
  const idempotencyKey = c.req.header("idempotency-key");
  if (idempotencyKey) {
    const seen = db
      .prepare("SELECT result FROM processed_mutations WHERE client_mutation_id = ?")
      .get(idempotencyKey) as { result: string } | undefined;
    if (seen) return c.json({ ...JSON.parse(seen.result), duplicate: true });
  }

  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(body.productId) as
    | { stock: number }
    | undefined;
  if (!product) return c.json({ error: `unknown product ${body.productId}` }, 422);

  const apply = db.transaction(() => {
    db.prepare(
      "INSERT INTO orders (id, shop_id, product_id, quantity, total_cents, created_at, server_seq) VALUES (?, 'shop-1', ?, ?, ?, ?, ?)",
    ).run(body.id, body.productId, body.quantity, body.totalCents, Date.now(), nextSeq());
    // the backend's own business rule: selling decrements stock (server-authoritative)
    db.prepare("UPDATE products SET stock = MAX(0, stock - ?), server_seq = ? WHERE id = ?").run(
      body.quantity,
      nextSeq(),
      body.productId,
    );
    const result = { ok: true, orderId: body.id };
    if (idempotencyKey) {
      db.prepare("INSERT INTO processed_mutations (client_mutation_id, result) VALUES (?, ?)").run(
        idempotencyKey,
        JSON.stringify(result),
      );
    }
    return result;
  });
  return c.json(apply());
});

// ── [SYNC ADDITION] the change feed offline clients pull ───────────────────────────────────
app.get("/sync/changes", (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const products = db.prepare("SELECT * FROM products WHERE server_seq > ?").all(since);
  const orders = db.prepare("SELECT * FROM orders WHERE server_seq > ?").all(since);
  const deleted = db.prepare("SELECT tbl, id FROM tombstones WHERE server_seq > ?").all(since);
  const seq = (db.prepare("SELECT seq FROM change_seq WHERE id = 1").get() as { seq: number }).seq;
  return c.json({ products, orders, deleted, seq });
});

const port = Number(process.env.PORT ?? 4600);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(
  `pos existing-api → http://127.0.0.1:${port} (sqlite: ${process.env.POS_DB ?? "pos-existing.db"})`,
);
