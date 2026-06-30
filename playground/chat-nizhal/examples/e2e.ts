import { PGlite } from "@electric-sql/pglite";
import type { Mutation } from "@nizhal/kernel";
import { issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import { createChatClient } from "../src/client.js";
import { CHAT_DDL, channelTimeline, chatSchema, chatSyncRules } from "../src/domain.js";
import { createChatServer } from "../src/server.js";

const SECRET = "chat-e2e-secret";
const WORKSPACE = "ws-1";
const USER = "user-1";
const CHANNEL = "channel-general";

export async function runChatE2e(): Promise<void> {
  const db = new PGlite();
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  const realtime = inProcessRealtime();
  let listener: ReturnType<ReturnType<typeof createChatServer>["listen"]> | null = null;

  try {
    await db.exec(CHAT_DDL);
    await storage.provision({ schema: chatSchema, syncRules: chatSyncRules });

    const server = createChatServer({ db: "postgres://unused", secret: SECRET, storage, realtime });
    listener = server.listen(0);
    const baseUrl = await baseUrlFor(listener);
    const token = issueBearerToken({ secret: SECRET, userId: USER, ownerId: WORKSPACE });
    const subscribeSource = {
      subscribe: (buckets: string[], onMessage: (message: string) => void) =>
        realtime.subscribe(buckets, { send: onMessage }),
    };

    // Bootstrap: create the channel + its first membership server-side BEFORE the test devices
    // subscribe, so the membership-gated bucket authorizes them from the first pull (deterministic).
    const bootstrap = await createChatClient({
      server: baseUrl,
      token,
      userId: USER,
      workspaceId: WORKSPACE,
      channelIds: [],
      subscribeSource,
    });
    bootstrap.mutate.createChannel({ id: CHANNEL, workspaceId: WORKSPACE, name: "general" });
    await bootstrap.waitForIdle();
    await waitFor(async () => {
      const rows = await db.query<{ count: number }>(
        "select count(*)::int as count from channel_members where channel_id = $1 and user_id = $2",
        [CHANNEL, USER],
      );
      return rows.rows[0]?.count === 1;
    });
    await bootstrap.dispose();

    const deviceA = await createChatClient({
      server: baseUrl,
      token,
      userId: USER,
      workspaceId: WORKSPACE,
      channelIds: [CHANNEL],
      subscribeSource,
    });
    const deviceB = await createChatClient({
      server: baseUrl,
      token,
      userId: USER,
      workspaceId: WORKSPACE,
      channelIds: [CHANNEL],
      subscribeSource,
    });

    // (1) realtime sync: A sends, B converges without any manual pull (poke-driven).
    deviceA.mutate.sendMessage({ id: "m-1", channelId: CHANNEL, body: "hello from A" });
    await waitFor(() => deviceB.messages.toArray.some((m) => m.id === "m-1"));
    assert(
      channelTimeline(deviceB.messages.toArray, CHANNEL).at(-1)?.body === "hello from A",
      "realtime: message sent on A appears on B",
    );

    // (2) offline -> online: gate A's push so the next message is held locally only.
    let releaseOffline!: () => void;
    const offlineGate = new Promise<void>((resolve) => {
      releaseOffline = resolve;
    });
    const push = deviceA.echo.push.bind(deviceA.echo);
    let captured: Mutation | null = null;
    deviceA.echo.push = async (mutation) => {
      if (mutation.name === "sendMessage" && (mutation.args as { id?: string })?.id === "m-2") {
        captured = mutation;
        await offlineGate;
      }
      return push(mutation);
    };

    deviceA.mutate.sendMessage({ id: "m-2", channelId: CHANNEL, body: "sent while offline" });
    await waitFor(() => captured !== null);
    assert(
      deviceA.messages.toArray.some((m) => m.id === "m-2"),
      "offline message is immediately visible on A (optimistic local write)",
    );
    const onServer = await db.query<{ count: number }>(
      "select count(*)::int as count from messages where id = $1",
      ["m-2"],
    );
    assert(onServer.rows[0]?.count === 0, "offline message has NOT reached the server");
    assert(
      !deviceB.messages.toArray.some((m) => m.id === "m-2"),
      "offline message has NOT reached B",
    );

    releaseOffline();
    await waitFor(() => deviceB.messages.toArray.some((m) => m.id === "m-2"));
    assert(
      channelTimeline(deviceB.messages.toArray, CHANNEL)
        .map((m) => m.id)
        .join(",") === "m-1,m-2",
      "on reconnect the offline message syncs and B converges in order",
    );

    await Promise.all([deviceA.dispose(), deviceB.dispose()]);
    console.log("\nCHAT-E2E: PASS ✅");
  } finally {
    if (listener) await closeServer(listener);
    await db.close();
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✅ ${message}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for chat convergence");
}

async function baseUrlFor(
  listener: ReturnType<ReturnType<typeof createChatServer>["listen"]>,
): Promise<string> {
  if (!listener.listening)
    await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(listener: ReturnType<ReturnType<typeof createChatServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runChatE2e().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
