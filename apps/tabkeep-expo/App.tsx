import { useLiveQuery } from "@tanstack/react-db";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ChatScreen } from "./src/chat/ChatScreen";
import {
  type CustomerRow,
  type LedgerEntryRow,
  createTabkeepExpoClient,
  foldLedgerBalance,
  formatMinorUnits,
} from "./src/domain";
import { openTabkeepPersistence } from "./src/persistence";
import { type CachedSession, loadSession, saveSession } from "./src/session";

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
    let cancelled = false;
    let opened: Client | null = null;

    const openClient = async (session: CachedSession) => {
      const c = await createTabkeepExpoClient({
        shopId: session.shopId,
        userId: session.userId,
        server: SERVER,
        realtimeHost: REALTIME_HOST,
        token: session.token,
        // Each token refresh (on 401) re-caches the session, so the next offline boot has a fresh token.
        refreshToken: async () => {
          const fresh = await fetchSession();
          await saveSession(fresh);
          return fresh.token;
        },
        persistence: await openTabkeepPersistence(),
      });
      if (cancelled) {
        void c.dispose();
        return;
      }
      opened = c;
      setClient(c);
      setNeedsConnection(false);
    };

    (async () => {
      // 1. Local-first: with a cached session, open the local replica IMMEDIATELY — works fully offline.
      const cached = await loadSession();
      if (cached && !cancelled) await openClient(cached);

      // 2. Background: refresh the session without ever blocking the local UI. With a cached session we
      //    try once (the live client self-heals via auth.refresh on reconnect); on a first-ever launch
      //    with no cache we retry until the server is first reachable, then open.
      while (!cancelled) {
        try {
          const fresh = await fetchSession();
          await saveSession(fresh);
          if (!cached && !cancelled) await openClient(fresh);
          break;
        } catch {
          if (cached) break;
          setNeedsConnection(true);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    })();

    return () => {
      cancelled = true;
      void opened?.dispose();
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
  const [amount, setAmount] = useState("");
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
  function record(kind: "credit" | "payment") {
    if (!selected) return;
    const minor = parseMinor(amount);
    if (minor == null) return;
    const args = { id: newId(), customerId: selected.id, amount: minor };
    if (kind === "credit") client.mutate.recordCredit(args);
    else client.mutate.recordPayment(args);
    setAmount("");
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
          const active = item.id === selectedId;
          return (
            <Pressable
              style={[styles.row, active && styles.rowActive]}
              onPress={() => setSelectedId(active ? null : item.id)}
            >
              <Text style={styles.rowName}>{item.name}</Text>
              <Text style={[styles.rowBal, balance > 0 ? styles.owes : styles.settled]}>
                {balance === 0 ? "settled" : formatMinorUnits(balance)}
              </Text>
            </Pressable>
          );
        }}
      />

      {selected ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{selected.name}</Text>
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
        </View>
      ) : null}
      <StatusBar style="auto" />
    </SafeAreaView>
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
});
