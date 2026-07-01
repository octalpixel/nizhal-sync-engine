import {
  kvSessionStore,
  localStorageSessionStore,
  startLocalFirstBootstrap,
} from "@nizhal/db-collection";
import { useLiveQuery } from "@tanstack/react-db";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ChatScreen } from "./src/chat/ChatScreen";
import { createTabkeepExpoClient } from "./src/client";
import {
  type CustomerRow,
  type LedgerEntryRow,
  foldLedgerBalance,
  formatMinorUnits,
} from "./src/domain";
import { openTabkeepPersistence } from "./src/persistence";

interface CachedSession {
  shopId: string;
  userId: string;
  token: string;
}

// EXPO_PUBLIC_APP=chat renders the Nizhal chat client (same hosted server); default is the ledger.
export default function App() {
  return process.env.EXPO_PUBLIC_APP === "chat" ? <ChatScreen /> : <LedgerApp />;
}

const SERVER = process.env.EXPO_PUBLIC_NIZHAL_SERVER ?? "http://127.0.0.1:4521";
// Set for a serverless server (Vercel) + dedicated CF realtime Worker; unset uses the server's own stream.
const REALTIME_HOST = process.env.EXPO_PUBLIC_NIZHAL_REALTIME_HOST;

type Client = Awaited<ReturnType<typeof createTabkeepExpoClient>>;

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
function formatWhen(value: unknown): string {
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
function parseMinor(input: string): number | null {
  const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

async function fetchSession(): Promise<CachedSession> {
  const res = await fetch(`${SERVER}/demo/session`);
  if (!res.ok) throw new Error(`demo session ${res.status}`);
  const s = (await res.json()) as { shopId: string; userId: string; token: string };
  return { shopId: s.shopId, userId: s.userId, token: s.token };
}

function LedgerApp() {
  const [client, setClient] = useState<Client | null>(null);
  const [needsConnection, setNeedsConnection] = useState(false);

  useEffect(() => {
    let disposed = false;
    let boot: { dispose(): void } | undefined;

    void (async () => {
      // Native persistence carries a durable KV (_nizhal_meta), so the session cache rides the same
      // store; web has no SQLite yet, so it falls back to localStorage. The rest of the local-first
      // launch dance (cached-open → background refresh → first-launch retry) lives in the framework.
      const persistence = await openTabkeepPersistence();
      if (disposed) return;
      const sessionStore = persistence
        ? kvSessionStore<CachedSession>(persistence.metaStorage, "tabkeep.session")
        : localStorageSessionStore<CachedSession>("tabkeep.session");
      boot = startLocalFirstBootstrap<CachedSession, Client>({
        sessionStore,
        fetchSession,
        openStore: (session, { refreshSession }) =>
          createTabkeepExpoClient({
            shopId: session.shopId,
            userId: session.userId,
            server: SERVER,
            realtimeHost: REALTIME_HOST,
            token: session.token,
            // Each 401 refresh re-caches the session, so the next offline boot has a fresh token.
            refreshToken: async () => (await refreshSession()).token,
            persistence,
          }),
        onOpen: setClient,
        onConnectionRequired: setNeedsConnection,
      });
      if (disposed) boot.dispose();
    })();

    return () => {
      disposed = true;
      boot?.dispose();
    };
  }, []);

  if (needsConnection && !client) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.brand}>Tabkeep</Text>
        <Text style={styles.muted}>Connect once to set up this device.</Text>
        <Text style={styles.muted}>
          You’re offline — the ledger opens here automatically the first time it reaches the server.
        </Text>
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }
  if (!client) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#b8862f" />
        <Text style={styles.muted}>Opening Tabkeep…</Text>
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }
  return <Ledger client={client} />;
}

function Ledger({ client }: { client: Client }) {
  const { data: customerData = [] } = useLiveQuery((q) => q.from({ customer: client.customers }));
  const { data: entryData = [] } = useLiveQuery((q) => q.from({ entry: client.ledgerEntries }));
  const customers = customerData as CustomerRow[];
  const entries = entryData as LedgerEntryRow[];

  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const selected = customers.find((c) => c.id === selectedId) ?? null;

  function toggleOffline() {
    const goOffline = !offline;
    client.onlineDetector.setOnline(!goOffline); // setOnline(false) holds the outbox; (true) flushes
    setOffline(goOffline);
  }
  function addCustomer() {
    const trimmed = name.trim();
    if (!trimmed) return;
    client.mutate.addCustomer({ id: newId(), name: trimmed });
    setName("");
  }

  if (selected) {
    return (
      <CustomerDetailScreen
        client={client}
        customer={selected}
        entries={entries.filter((e) => e.customer_id === selected.id)}
        offline={offline}
        onToggleOffline={toggleOffline}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>Tabkeep</Text>
          <Text style={styles.eyebrow}>CREDIT LEDGER · EXPO</Text>
        </View>
        <Pressable
          style={[styles.netToggle, offline ? styles.netOffline : styles.netOnline]}
          onPress={toggleOffline}
        >
          <Text style={styles.netToggleText}>{offline ? "● Offline" : "● Online"}</Text>
        </Pressable>
      </View>

      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          placeholder="New customer name"
          placeholderTextColor="#9a9484"
          value={name}
          onChangeText={setName}
          onSubmitEditing={addCustomer}
        />
        <Pressable style={styles.btnGold} onPress={addCustomer}>
          <Text style={styles.btnGoldText}>Add</Text>
        </Pressable>
      </View>

      <FlatList
        data={customers}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={<Text style={styles.muted}>No customers yet. Add one above.</Text>}
        renderItem={({ item }) => {
          const balance = foldLedgerBalance(entries, item.id);
          return (
            <Pressable style={styles.row} onPress={() => setSelectedId(item.id)}>
              <Text style={styles.rowName}>{item.name}</Text>
              <View style={styles.rowRight}>
                <Text style={[styles.rowBal, balance > 0 ? styles.owes : styles.settled]}>
                  {balance === 0 ? "settled" : formatMinorUnits(balance)}
                </Text>
                <Text style={styles.chevron}>›</Text>
              </View>
            </Pressable>
          );
        }}
      />
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

function CustomerDetailScreen({
  client,
  customer,
  entries,
  offline,
  onToggleOffline,
  onBack,
}: {
  client: Client;
  customer: CustomerRow;
  entries: LedgerEntryRow[];
  offline: boolean;
  onToggleOffline: () => void;
  onBack: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [entryDetail, setEntryDetail] = useState<LedgerEntryRow | null>(null);
  const balance = foldLedgerBalance(entries, customer.id);
  const chronological = [...entries].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  function record(kind: "credit" | "payment") {
    const minor = parseMinor(amount);
    if (minor == null) return;
    const args = { id: newId(), customerId: customer.id, amount: minor };
    if (kind === "credit") client.mutate.recordCredit(args);
    else client.mutate.recordPayment(args);
    setAmount("");
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.back}>← All customers</Text>
        </Pressable>
        <Pressable
          style={[styles.netToggle, offline ? styles.netOffline : styles.netOnline]}
          onPress={onToggleOffline}
        >
          <Text style={styles.netToggleText}>{offline ? "● Offline" : "● Online"}</Text>
        </Pressable>
      </View>

      <View style={styles.hero}>
        <View style={styles.heroLeft}>
          <Text style={styles.eyebrow}>RUNNING TAB</Text>
          <Text style={styles.brand}>{customer.name}</Text>
          <Pressable onPress={() => setRenaming(true)}>
            <Text style={styles.link}>✎ Edit name</Text>
          </Pressable>
        </View>
        <Text style={[styles.heroBalance, balance > 0 ? styles.owes : styles.settled]}>
          {balance === 0 ? "settled" : formatMinorUnits(balance)}
        </Text>
      </View>

      <TextInput
        style={styles.input}
        placeholder="Amount e.g. 250.00"
        placeholderTextColor="#9a9484"
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
      />
      <View style={styles.panelBtns}>
        <Pressable style={[styles.btn, styles.btnCredit]} onPress={() => record("credit")}>
          <Text style={styles.btnText}>Add credit</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnPay]} onPress={() => record("payment")}>
          <Text style={styles.btnText}>Record payment</Text>
        </Pressable>
      </View>

      <Text style={styles.histHeading}>Ledger history · {chronological.length}</Text>
      <FlatList
        data={chronological}
        keyExtractor={(e) => e.id}
        ListEmptyComponent={<Text style={styles.muted}>No entries yet. Add credit above.</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.histRow} onPress={() => setEntryDetail(item)}>
            <Text style={styles.histKind}>
              {item.kind === "credit" ? "Credit given" : "Payment received"}
            </Text>
            <Text style={item.kind === "credit" ? styles.owes : styles.settled}>
              {item.kind === "credit" ? "+" : "−"}
              {formatMinorUnits(item.amount)}
            </Text>
          </Pressable>
        )}
      />

      <RenameModal
        visible={renaming}
        customer={customer}
        client={client}
        onClose={() => setRenaming(false)}
      />
      <EntryDetailModal entry={entryDetail} onClose={() => setEntryDetail(null)} />
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

function RenameModal({
  visible,
  customer,
  client,
  onClose,
}: { visible: boolean; customer: CustomerRow; client: Client; onClose: () => void }) {
  const [value, setValue] = useState(customer.name);
  useEffect(() => setValue(customer.name), [customer.name]);
  function save() {
    const trimmed = value.trim();
    if (!trimmed) return;
    client.mutate.renameCustomer({ id: customer.id, name: trimmed });
    onClose();
  }
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Edit customer</Text>
          <TextInput
            style={[styles.input, styles.modalInput]}
            value={value}
            onChangeText={setValue}
            autoFocus
          />
          <View style={styles.panelBtns}>
            <Pressable style={[styles.btn, styles.btnPay]} onPress={save}>
              <Text style={styles.btnText}>Save</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnCredit]} onPress={onClose}>
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function EntryDetailModal({
  entry,
  onClose,
}: { entry: LedgerEntryRow | null; onClose: () => void }) {
  const isCredit = entry?.kind === "credit";
  return (
    <Modal visible={entry != null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>{isCredit ? "Credit given" : "Payment received"}</Text>
          {entry ? (
            <View style={{ gap: 8 }}>
              <DetailRow
                label="Amount"
                value={`${isCredit ? "+" : "−"}${formatMinorUnits(entry.amount)}`}
              />
              <DetailRow label="Note" value={entry.note || "—"} />
              <DetailRow label="Recorded" value={formatWhen(entry.created_at)} />
              <DetailRow label="Entry id" value={entry.id} />
            </View>
          ) : null}
          <Pressable style={[styles.btn, styles.btnCredit]} onPress={onClose}>
            <Text style={styles.btnText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f4efe4", paddingHorizontal: 20, paddingTop: 24 },
  center: {
    flex: 1,
    backgroundColor: "#f4efe4",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
  },
  header: {
    marginBottom: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  netToggle: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  netOnline: { backgroundColor: "#e3f0e7", borderColor: "#bcdcc6" },
  netOffline: { backgroundColor: "#f3ddd4", borderColor: "#edc9b8" },
  netToggleText: { fontWeight: "700", fontSize: 13, color: "#1d1b16" },
  brand: { fontSize: 28, fontWeight: "700", color: "#1d1b16" },
  eyebrow: { fontSize: 12, letterSpacing: 1.5, color: "#6f6a5c", marginTop: 2 },
  addRow: { flexDirection: "row", gap: 10, marginBottom: 16 },
  input: {
    flex: 1,
    backgroundColor: "#fffdf7",
    borderWidth: 1,
    borderColor: "#d9d2c0",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: "#1d1b16",
  },
  btnGold: {
    backgroundColor: "#e6b84f",
    borderRadius: 10,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
  btnGoldText: { fontWeight: "700", color: "#1d1b16", fontSize: 16 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e4ddca",
  },
  rowActive: { backgroundColor: "#fffdf7", borderRadius: 10, paddingHorizontal: 12 },
  rowName: { fontSize: 17, fontWeight: "600", color: "#1d1b16" },
  rowBal: { fontSize: 16, fontVariant: ["tabular-nums"] },
  owes: { color: "#b25433", fontWeight: "700" },
  settled: { color: "#3f7a52" },
  panel: {
    backgroundColor: "#fffdf7",
    borderWidth: 1,
    borderColor: "#d9d2c0",
    borderRadius: 14,
    padding: 16,
    marginVertical: 16,
    gap: 12,
  },
  panelTitle: { fontSize: 20, fontWeight: "700", color: "#1d1b16" },
  panelBtns: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: "center" },
  btnCredit: { backgroundColor: "#edc9b8" },
  btnPay: { backgroundColor: "#bcdcc6" },
  btnText: { fontWeight: "700", color: "#1d1b16", fontSize: 15 },
  muted: { color: "#6f6a5c", fontSize: 15, textAlign: "center", marginTop: 12 },
  error: { fontSize: 18, fontWeight: "700", color: "#b00020" },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  chevron: { color: "#b0a892", fontSize: 22, fontWeight: "700" },
  back: { color: "#8a6a1f", fontSize: 16, fontWeight: "700" },
  hero: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
  },
  heroLeft: { flex: 1, gap: 4 },
  heroBalance: { fontSize: 22, fontWeight: "800", fontVariant: ["tabular-nums"] },
  link: { color: "#8a6a1f", fontWeight: "700", fontSize: 14, marginTop: 4 },
  histHeading: {
    fontSize: 13,
    letterSpacing: 1,
    color: "#6f6a5c",
    fontWeight: "700",
    marginTop: 8,
    marginBottom: 4,
  },
  histRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#e4ddca",
  },
  histKind: { fontSize: 16, color: "#1d1b16", fontWeight: "600" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(29,27,22,0.35)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: "#fffdf7",
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  modalTitle: { fontSize: 20, fontWeight: "700", color: "#1d1b16" },
  // base input uses flex:1 for the add-row; inside the auto-height modal card that collapses to ~0
  // height and hides the text — pin it to its natural single-line height instead.
  modalInput: { flex: 0, alignSelf: "stretch" },
  detailRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  detailLabel: { color: "#6f6a5c", fontSize: 14 },
  detailValue: {
    color: "#1d1b16",
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },
});
