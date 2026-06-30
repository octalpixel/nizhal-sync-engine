import type { NizhalCollection } from "@nizhal/db-collection";
import { useEffect, useMemo, useState } from "react";
import { type PosStore, createPosStore } from "./nizhal/client";
import type { ProductRow, SaleItemRow, SaleRow } from "./nizhal/schema";

function useRows<T extends object>(collection: NizhalCollection<T>): T[] {
  const [rows, setRows] = useState<T[]>(() => [...collection.toArray]);
  useEffect(() => {
    const read = () => setRows([...collection.toArray]);
    read();
    const sub = collection.subscribeChanges(read);
    return () => sub.unsubscribe();
  }, [collection]);
  return rows;
}

const uuid = () => crypto.randomUUID();

export function App() {
  const [store, setStore] = useState<PosStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createPosStore()
      .then(setStore)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <pre className="error">offline store failed: {error}</pre>;
  if (!store) return <p className="wrap muted">Opening offline store…</p>;
  return <Pos store={store} />;
}

function Pos({ store }: { store: PosStore }) {
  const products = useRows<ProductRow>(store.products);
  const sales = useRows<SaleRow>(store.sales);
  const saleItems = useRows<SaleItemRow>(store.saleItems);

  const [form, setForm] = useState({ name: "", price: "", stock: "" });
  const [cart, setCart] = useState<Record<string, number>>({});

  // Available stock = initial − sold (fold over sale_items), since mutators don't decrement.
  const soldByProduct = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of saleItems) m[it.product_id] = (m[it.product_id] ?? 0) + it.qty;
    return m;
  }, [saleItems]);
  const available = (p: ProductRow) => p.stock - (soldByProduct[p.id] ?? 0);

  async function addProduct(e: React.FormEvent) {
    e.preventDefault();
    await store.mutate.addProduct({
      clientId: uuid(),
      name: form.name,
      price: Number(form.price),
      stock: Number(form.stock || 0),
    });
    setForm({ name: "", price: "", stock: "" });
  }

  const cartItems = Object.entries(cart).filter(([, q]) => q > 0);
  const cartTotal = cartItems.reduce(
    (sum, [id, q]) => sum + (products.find((p) => p.id === id)?.price ?? 0) * q,
    0,
  );

  async function checkout() {
    await store.mutate.recordSale({
      clientId: uuid(),
      items: cartItems.map(([productId, qty]) => ({
        itemId: uuid(),
        productId,
        qty,
        unitPrice: products.find((p) => p.id === productId)?.price ?? 0,
      })),
    });
    setCart({});
  }

  return (
    <main className="wrap">
      <h1>POS · offline</h1>
      <p className="muted">
        Backed by wa-sqlite in your browser. Add data, then reload or go offline — it stays.
      </p>

      <section className="grid">
        <div className="panel">
          <h2>Products</h2>
          <form onSubmit={addProduct} className="row">
            <input
              placeholder="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <input
              placeholder="price"
              type="number"
              step="0.01"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              required
            />
            <input
              placeholder="stock"
              type="number"
              value={form.stock}
              onChange={(e) => setForm({ ...form, stock: e.target.value })}
            />
            <button type="submit">Add</button>
          </form>
          <ul className="list">
            {products.map((p) => (
              <li key={p.id}>
                <span>
                  {p.name} · ${p.price.toFixed(2)} · stock {available(p)}
                </span>
                <span className="qty">
                  <button
                    type="button"
                    onClick={() => setCart({ ...cart, [p.id]: Math.max(0, (cart[p.id] ?? 0) - 1) })}
                  >
                    −
                  </button>
                  {cart[p.id] ?? 0}
                  <button
                    type="button"
                    disabled={(cart[p.id] ?? 0) >= available(p)}
                    onClick={() => setCart({ ...cart, [p.id]: (cart[p.id] ?? 0) + 1 })}
                  >
                    +
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <h2>Sale</h2>
          {cartItems.length === 0 ? (
            <p className="muted">Add products to the cart.</p>
          ) : (
            <>
              <ul className="list">
                {cartItems.map(([id, q]) => (
                  <li key={id}>
                    <span>{products.find((p) => p.id === id)?.name}</span>
                    <span>× {q}</span>
                  </li>
                ))}
              </ul>
              <p className="total">Total ${cartTotal.toFixed(2)}</p>
              <button type="button" className="primary" onClick={checkout}>
                Charge
              </button>
            </>
          )}
          <h2>Recent sales</h2>
          <ul className="list">
            {[...sales]
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .map((s) => (
                <li key={s.id}>
                  <span className="muted">{new Date(s.created_at).toLocaleString()}</span>
                  <span>${s.total.toFixed(2)}</span>
                </li>
              ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
