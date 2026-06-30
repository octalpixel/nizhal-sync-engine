import { waSqlitePersistence } from "@nizhal/db-collection";
import { createChatClient } from "./client.js";
import { openWaSqlite } from "./wa.js";

const SERVER = (import.meta.env.VITE_CHAT_SERVER as string | undefined) ?? "http://127.0.0.1:4600";
const REALTIME_HOST = import.meta.env.VITE_NIZHAL_REALTIME_HOST as string | undefined;

interface DemoSession {
  userId: string;
  workspaceId: string;
  channelIds: string[];
  token: string;
}

// Web client: durable wa-sqlite replica per user (so a tab survives reload offline), wired to the
// chat server. The server's /sync/stream drives realtime; pullIntervalMs is a poll fallback.
export async function createWebChatClient() {
  const user = new URLSearchParams(location.search).get("user") ?? "ada";
  const session = (await (
    await fetch(`${SERVER}/demo/session?user=${encodeURIComponent(user)}`)
  ).json()) as DemoSession;
  const db = await openWaSqlite(`chat-${session.userId}.db`);
  const persistence = await waSqlitePersistence({ database: db });
  const client = await createChatClient({
    server: SERVER,
    token: session.token,
    userId: session.userId,
    workspaceId: session.workspaceId,
    channelIds: session.channelIds,
    persistence,
    ...(REALTIME_HOST ? { realtimeHost: REALTIME_HOST } : {}),
    pullIntervalMs: 1500,
  });
  return Object.assign(client, {
    user: session.userId,
    channelId: session.channelIds[0] as string,
  });
}
