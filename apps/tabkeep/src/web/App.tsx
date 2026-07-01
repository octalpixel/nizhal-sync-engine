import { waSqlitePersistence } from "@nizhal/db-collection";
import { useLiveQuery } from "@tanstack/react-db";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  type TabkeepClient,
  createTabkeepClient,
  foldLedgerBalance,
  formatMinorUnits,
  parseMinorUnits,
} from "../client.js";
import type { CustomerRow, LedgerEntryRow } from "../schema.js";
import { openTabkeepDatabase } from "./wa.js";

const SHOP_ID = import.meta.env.VITE_TABKEEP_SHOP_ID || "shop-1";
const USER_ID = import.meta.env.VITE_TABKEEP_USER_ID || "user-1";

export interface DemoSession {
  token: string;
  shopId: string;
  userId: string;
}

/** Lets a demo entry (e.g. App.CF) route realtime through a custom transport (a Cloudflare DO). */
export type SubscribeSourceFactory = (
  session: DemoSession,
) => Parameters<typeof createTabkeepClient>[0]["subscribeSource"];

interface OpenedClient {
  client: TabkeepClient;
  startupNote: string | null;
}

let openedClient: Promise<OpenedClient> | null = null;

function openClientOnce(buildSubscribeSource?: SubscribeSourceFactory): Promise<OpenedClient> {
  if (!openedClient) {
    openedClient = openClient(buildSubscribeSource);
    window.addEventListener(
      "pagehide",
      () => {
        void openedClient?.then(({ client }) => client.dispose());
      },
      { once: true },
    );
  }
  return openedClient;
}

async function openClient(buildSubscribeSource?: SubscribeSourceFactory): Promise<OpenedClient> {
  const database = await openTabkeepDatabase();
  const persistence = await waSqlitePersistence({ database });
  const configuredServer = import.meta.env.VITE_NIZHAL_SERVER as string | undefined;
  const configuredToken = import.meta.env.VITE_NIZHAL_TOKEN as string | undefined;

  if (configuredServer && configuredToken) {
    return {
      client: await createTabkeepClient({
        shopId: SHOP_ID,
        userId: USER_ID,
        server: configuredServer,
        token: configuredToken,
        persistence,
      }),
      startupNote: null,
    };
  }

  try {
    const response = await fetch("/demo/session", { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) throw new Error(`demo session returned ${response.status}`);
    const session = (await response.json()) as DemoSession;
    return {
      client: await createTabkeepClient({
        shopId: session.shopId,
        userId: session.userId,
        server: window.location.origin,
        token: session.token,
        refreshToken: async () => {
          const r = await fetch("/demo/session");
          if (!r.ok) throw new Error(`demo session returned ${r.status}`);
          return ((await r.json()) as DemoSession).token;
        },
        persistence,
        subscribeSource: buildSubscribeSource?.(session),
      }),
      startupNote: null,
    };
  } catch (error) {
    return {
      client: await createTabkeepClient({ shopId: SHOP_ID, userId: USER_ID, persistence }),
      startupNote: `Server unavailable; opened the durable local ledger. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function App({
  buildSubscribeSource,
}: { buildSubscribeSource?: SubscribeSourceFactory } = {}) {
  const [opened, setOpened] = useState<OpenedClient | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openClientOnce(buildSubscribeSource).then(
      (result) => {
        if (!cancelled) setOpened(result);
      },
      (error) => {
        if (!cancelled) setFatalError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (fatalError) {
    return (
      <main className="centered-state">
        <p className="eyebrow">Tabkeep</p>
        <h1>Could not open the ledger</h1>
        <p>{fatalError}</p>
      </main>
    );
  }
  if (!opened) {
    return (
      <main className="centered-state">
        <span className="loading-mark" aria-hidden="true" />
        <p>Opening your offline ledger…</p>
      </main>
    );
  }
  return <Ledger client={opened.client} startupNote={opened.startupNote} />;
}

function Ledger({ client, startupNote }: OpenedClient) {
  const { data: customerData = [] } = useLiveQuery((query) =>
    query.from({ customer: client.customers }),
  );
  const { data: entryData = [] } = useLiveQuery((query) =>
    query.from({ entry: client.ledgerEntries }),
  );
  const customers = customerData as CustomerRow[];
  const entries = entryData as LedgerEntryRow[];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (selectedId && !customers.some((customer) => customer.id === selectedId)) {
      setSelectedId(null);
    }
  }, [customers, selectedId]);

  const balances = useMemo(() => {
    const result = new Map<string, number>();
    for (const entry of entries) {
      const movement = entry.kind === "credit" ? entry.amount : -entry.amount;
      result.set(entry.customer_id, (result.get(entry.customer_id) ?? 0) + movement);
    }
    return result;
  }, [entries]);

  const selected = customers.find((customer) => customer.id === selectedId) ?? null;
  const connectionLabel = !online
    ? "Offline"
    : client.remoteSyncEnabled
      ? "Synced locally"
      : "Local only";

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setSelectedId(null)}>
          <span className="brand-mark">T</span>
          <span>
            <strong>Tabkeep</strong>
            <small>Credit ledger</small>
          </span>
        </button>
        <div className={`connection ${online ? "is-online" : "is-offline"}`}>
          <span aria-hidden="true" />
          {connectionLabel}
        </div>
      </header>

      {startupNote ? <p className="offline-note">{startupNote}</p> : null}

      {selected ? (
        <CustomerDetail
          client={client}
          customer={selected}
          entries={entries.filter((entry) => entry.customer_id === selected.id)}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <section className="customer-page">
          <div className="page-heading">
            <div>
              <p className="eyebrow">Your book</p>
              <h1>Customer balances</h1>
              <p>Every balance is folded from an append-only history.</p>
            </div>
            <button
              className="primary-button"
              type="button"
              onClick={() => setShowCustomerForm(true)}
            >
              <span aria-hidden="true">＋</span> Add customer
            </button>
          </div>

          {customers.length === 0 ? (
            <button
              className="empty-ledger"
              type="button"
              onClick={() => setShowCustomerForm(true)}
            >
              <span className="empty-icon" aria-hidden="true">
                ＋
              </span>
              <strong>Start your ledger</strong>
              <span>Add the first customer. It works even without a connection.</span>
            </button>
          ) : (
            <div className="customer-list">
              {[...customers]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((customer) => {
                  const balance = balances.get(customer.id) ?? 0;
                  return (
                    <button
                      className="customer-row"
                      type="button"
                      key={customer.id}
                      onClick={() => setSelectedId(customer.id)}
                    >
                      <span className="avatar" aria-hidden="true">
                        {initials(customer.name)}
                      </span>
                      <span className="customer-identity">
                        <strong>{customer.name}</strong>
                        <small>{customer.phone || "No phone number"}</small>
                      </span>
                      <span className={`balance ${balance > 0 ? "is-owed" : "is-settled"}`}>
                        <strong>{formatMinorUnits(balance)}</strong>
                        <small>{balance > 0 ? "owes you" : "settled"}</small>
                      </span>
                      <span className="chevron" aria-hidden="true">
                        →
                      </span>
                    </button>
                  );
                })}
            </div>
          )}
        </section>
      )}

      {showCustomerForm ? (
        <AddCustomerForm client={client} onClose={() => setShowCustomerForm(false)} />
      ) : null}
    </main>
  );
}

function CustomerDetail({
  client,
  customer,
  entries,
  onBack,
}: {
  client: TabkeepClient;
  customer: CustomerRow;
  entries: LedgerEntryRow[];
  onBack: () => void;
}) {
  const [action, setAction] = useState<"credit" | "payment" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [entryDetail, setEntryDetail] = useState<LedgerEntryRow | null>(null);
  const balance = foldLedgerBalance(entries, customer.id);
  const chronological = [...entries].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <section className="detail-page">
      <button className="back-button" type="button" onClick={onBack}>
        ← All customers
      </button>
      <div className="customer-hero">
        <div>
          <p className="eyebrow">Running tab</p>
          <h1>{customer.name}</h1>
          <p>{customer.phone || "No phone number"}</p>
          <button className="back-button" type="button" onClick={() => setRenaming(true)}>
            ✎ Edit name
          </button>
        </div>
        <div className={`hero-balance ${balance > 0 ? "is-owed" : "is-settled"}`}>
          <small>{balance > 0 ? "Owes you" : "Balance"}</small>
          <strong>{formatMinorUnits(balance)}</strong>
        </div>
      </div>
      <div className="action-grid">
        <button className="credit-action" type="button" onClick={() => setAction("credit")}>
          <span>↑</span>
          <strong>Add credit</strong>
          <small>They owe more</small>
        </button>
        <button className="payment-action" type="button" onClick={() => setAction("payment")}>
          <span>↓</span>
          <strong>Record payment</strong>
          <small>They paid you</small>
        </button>
      </div>
      <div className="history-heading">
        <h2>Ledger history</h2>
        <span>
          {chronological.length} {chronological.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      {chronological.length === 0 ? (
        <p className="empty-history">No entries yet. Add credit when this customer starts a tab.</p>
      ) : (
        <ol className="history-list">
          {chronological.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => setEntryDetail(entry)}
                style={{ all: "unset", cursor: "pointer", display: "contents" }}
                aria-label={`View ${entry.kind} of ${formatMinorUnits(entry.amount)}`}
              >
                <span className={`movement-icon ${entry.kind}`} aria-hidden="true">
                  {entry.kind === "credit" ? "↑" : "↓"}
                </span>
                <span className="movement-copy">
                  <strong>{entry.kind === "credit" ? "Credit given" : "Payment received"}</strong>
                  <small>{entry.note || formatWhen(entry.created_at)}</small>
                </span>
                <span className={entry.kind === "credit" ? "credit-amount" : "payment-amount"}>
                  {entry.kind === "credit" ? "+" : "−"}
                  {formatMinorUnits(entry.amount)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {action ? (
        <EntryForm
          client={client}
          customer={customer}
          kind={action}
          onClose={() => setAction(null)}
        />
      ) : null}
      {renaming ? (
        <RenameCustomerForm
          client={client}
          customer={customer}
          onClose={() => setRenaming(false)}
        />
      ) : null}
      {entryDetail ? (
        <EntryDetail entry={entryDetail} onClose={() => setEntryDetail(null)} />
      ) : null}
    </section>
  );
}

function RenameCustomerForm({
  client,
  customer,
  onClose,
}: { client: TabkeepClient; customer: CustomerRow; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) return;
    try {
      client.mutate.renameCustomer({ id: customer.id, name });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  }

  return (
    <Modal title="Edit customer" onClose={onClose}>
      <form className="entry-form" onSubmit={submit}>
        <label>
          Name
          <input name="name" defaultValue={customer.name} autoComplete="name" required />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button full" type="submit">
          Save changes
        </button>
      </form>
    </Modal>
  );
}

function EntryDetail({ entry, onClose }: { entry: LedgerEntryRow; onClose: () => void }) {
  const isCredit = entry.kind === "credit";
  return (
    <Modal title={isCredit ? "Credit given" : "Payment received"} onClose={onClose}>
      <p className="form-context">{isCredit ? "They owe more" : "They paid you"}</p>
      <dl className="entry-detail">
        <div>
          <dt>Amount</dt>
          <dd className={isCredit ? "credit-amount" : "payment-amount"}>
            {isCredit ? "+" : "−"}
            {formatMinorUnits(entry.amount)}
          </dd>
        </div>
        <div>
          <dt>Note</dt>
          <dd>{entry.note || "—"}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{formatWhen(entry.created_at)}</dd>
        </div>
        <div>
          <dt>Entry id</dt>
          <dd>
            <code>{entry.id}</code>
          </dd>
        </div>
      </dl>
    </Modal>
  );
}

function AddCustomerForm({ client, onClose }: { client: TabkeepClient; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      client.mutate.addCustomer({
        id: crypto.randomUUID(),
        name: String(data.get("name") ?? ""),
        phone: String(data.get("phone") ?? ""),
      });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  }

  return (
    <Modal title="Add customer" onClose={onClose}>
      <form className="entry-form" onSubmit={submit}>
        <label>
          Name
          <input name="name" autoComplete="name" required />
        </label>
        <label>
          Phone <span>optional</span>
          <input name="phone" inputMode="tel" autoComplete="tel" />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button full" type="submit">
          Add to ledger
        </button>
      </form>
    </Modal>
  );
}

function EntryForm({
  client,
  customer,
  kind,
  onClose,
}: {
  client: TabkeepClient;
  customer: CustomerRow;
  kind: "credit" | "payment";
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const input = {
        id: crypto.randomUUID(),
        customerId: customer.id,
        amount: parseMinorUnits(String(data.get("amount") ?? "")),
        note: String(data.get("note") ?? ""),
      };
      if (kind === "credit") client.mutate.recordCredit(input);
      else client.mutate.recordPayment(input);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  }

  return (
    <Modal title={kind === "credit" ? "Add credit" : "Record payment"} onClose={onClose}>
      <p className="form-context">For {customer.name}</p>
      <form className="entry-form" onSubmit={submit}>
        <label>
          Amount
          <input name="amount" inputMode="decimal" placeholder="0.00" required />
        </label>
        <label>
          Note <span>optional</span>
          <input name="note" placeholder="What was this for?" />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button
          className={`full ${kind === "credit" ? "credit-submit" : "payment-submit"}`}
          type="submit"
        >
          {kind === "credit" ? "Add credit" : "Record payment"}
        </button>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <dialog className="modal" open aria-labelledby="modal-title">
        <div className="modal-heading">
          <h2 id="modal-title">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </dialog>
    </div>
  );
}

function formatWhen(value: unknown): string {
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
