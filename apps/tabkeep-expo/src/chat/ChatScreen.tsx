import type { NizhalCollection } from "@nizhal/db-collection";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { type ChatExpoClient, createChatExpoClient } from "./client";
import { type MessageRow, channelTimeline } from "./domain";

const SERVER = process.env.EXPO_PUBLIC_NIZHAL_SERVER ?? "http://127.0.0.1:4600";
const REALTIME_HOST = process.env.EXPO_PUBLIC_NIZHAL_REALTIME_HOST;
const CHAT_USER = process.env.EXPO_PUBLIC_CHAT_USER ?? "lin";

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function useCollection<T extends object>(collection: NizhalCollection<T>): T[] {
  const [rows, setRows] = useState<T[]>(() => [...collection.toArray]);
  useEffect(() => {
    const read = () => setRows([...collection.toArray]);
    read();
    const sub = collection.subscribeChanges(read);
    return () => sub.unsubscribe();
  }, [collection]);
  return rows;
}

export function ChatScreen() {
  const [client, setClient] = useState<ChatExpoClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let opened: ChatExpoClient | null = null;
    (async () => {
      try {
        const fetchSession = async () =>
          (await (await fetch(`${SERVER}/demo/session?user=${CHAT_USER}`)).json()) as {
            userId: string;
            workspaceId: string;
            channelIds: string[];
            token: string;
          };
        const session = await fetchSession();
        opened = await createChatExpoClient({
          server: SERVER,
          realtimeHost: REALTIME_HOST,
          token: session.token,
          userId: session.userId,
          workspaceId: session.workspaceId,
          channelIds: session.channelIds,
          refreshToken: async () => (await fetchSession()).token,
        });
        if (!cancelled) setClient(opened);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void opened?.dispose();
    };
  }, []);

  if (error)
    return (
      <SafeAreaView style={s.center}>
        <Text style={s.err}>{error}</Text>
      </SafeAreaView>
    );
  if (!client)
    return (
      <SafeAreaView style={s.center}>
        <ActivityIndicator color="#9aa0a6" />
        <Text style={s.muted}>Connecting…</Text>
      </SafeAreaView>
    );
  return <Chat client={client} />;
}

function Chat({ client }: { client: ChatExpoClient }) {
  const messages = useCollection(client.messages) as MessageRow[];
  const [text, setText] = useState("");
  const [offline, setOffline] = useState(false);
  const [failed, setFailed] = useState(client.deadLetter.length);
  const timeline = channelTimeline(messages, client.channelId);

  // RFC-011 F-B: a parked write must be visible + retryable, never silently lost.
  useEffect(() => {
    const update = () => setFailed(client.deadLetter.length);
    update();
    return client.onDeadLetterChange(update);
  }, [client]);

  const toggleNet = () => {
    const goOffline = !offline;
    client.onlineDetector.setOnline(!goOffline); // false = hold outbox; true = flush
    setOffline(goOffline);
  };

  const send = () => {
    const body = text.trim();
    if (!body) return;
    client.mutate.sendMessage({ id: newId(), channelId: client.channelId, body });
    setText("");
  };

  return (
    <SafeAreaView style={s.app}>
      <View style={s.header}>
        <Text style={s.title}># {client.channelId}</Text>
        <View style={s.headerRight}>
          <Pressable
            style={[s.netToggle, offline ? s.netOffline : s.netOnline]}
            onPress={toggleNet}
          >
            <Text style={[s.netText, offline ? s.netTextOff : s.netTextOn]}>
              {offline ? "● Offline" : "● Online"}
            </Text>
          </Pressable>
          <Text style={s.badge}>{client.user} · mobile</Text>
        </View>
      </View>
      <FlatList
        style={s.list}
        contentContainerStyle={s.listContent}
        data={timeline}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={[s.row, item.author_id === client.user && s.rowMine]}>
            <Text style={s.author}>{item.author_id}</Text>
            <View style={[s.bubble, item.author_id === client.user && s.bubbleMine]}>
              <Text style={[s.body, item.author_id === client.user && s.bodyMine]}>
                {item.body}
              </Text>
            </View>
          </View>
        )}
      />
      {failed > 0 && (
        <View style={s.dlBanner}>
          <Text style={s.dlText}>
            {failed} message{failed > 1 ? "s" : ""} failed to send
          </Text>
          <Pressable style={s.dlBtn} onPress={() => void client.retryDeadLetter()}>
            <Text style={s.dlBtnText}>Retry</Text>
          </Pressable>
        </View>
      )}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={s.composer}>
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder={`Message #${client.channelId}`}
            placeholderTextColor="#6b7280"
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <Pressable style={s.send} onPress={send}>
            <Text style={s.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#0f1115" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0f1115",
    gap: 8,
  },
  muted: { color: "#9aa0a6" },
  err: { color: "#f28b82", padding: 24, textAlign: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#23262e",
  },
  title: { color: "#e8eaed", fontSize: 18, fontWeight: "700" },
  badge: {
    color: "#c8cdd6",
    backgroundColor: "#1c1f27",
    borderColor: "#2a2e38",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    fontSize: 13,
  },
  list: { flex: 1 },
  listContent: { padding: 14, gap: 8 },
  row: { alignItems: "flex-start", maxWidth: "82%" },
  rowMine: { alignSelf: "flex-end", alignItems: "flex-end" },
  author: { color: "#8a92a0", fontSize: 11, marginHorizontal: 6, marginBottom: 2 },
  bubble: {
    backgroundColor: "#1c1f27",
    borderColor: "#2a2e38",
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleMine: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  body: { color: "#e8eaed" },
  bodyMine: { color: "#fff" },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: "#23262e",
  },
  input: {
    flex: 1,
    backgroundColor: "#14171d",
    borderColor: "#2a2e38",
    borderWidth: 1,
    color: "#e8eaed",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  send: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  sendText: { color: "#fff", fontWeight: "700" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  netToggle: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  netOnline: { borderColor: "#1f3d33", backgroundColor: "#13241d" },
  netOffline: { borderColor: "#4a3a1a", backgroundColor: "#2a2113" },
  netText: { fontSize: 12, fontWeight: "600" },
  netTextOn: { color: "#34d399" },
  netTextOff: { color: "#f59e0b" },
  dlBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#2a2113",
    borderColor: "#4a3a1a",
    borderWidth: 1,
    borderRadius: 10,
  },
  dlText: { color: "#f59e0b", fontSize: 13 },
  dlBtn: { backgroundColor: "#f59e0b", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 },
  dlBtnText: { color: "#1d1b16", fontWeight: "700" },
});
