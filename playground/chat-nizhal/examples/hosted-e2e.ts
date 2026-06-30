// Hosted e2e: the same 2-client chat flow as examples/e2e.ts, but against a REAL hosted Postgres
// (Neon) via the actual postgresStorage adapter (pooled endpoint, row-version triggers, audit) instead
// of in-process PGlite. Proves the chat app persists + syncs + converges through the hosted data path.
// Run: DATABASE_URL=<neon> pnpm --filter chat-nizhal example:hosted-e2e   (provision first).
import { issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import postgres from "postgres";
import { createChatClient } from "../src/client.js";
import { channelTimeline } from "../src/domain.js";
import { createChatServer } from "../src/server.js";

const SECRET = process.env.NIZHAL_JWT_SECRET ?? "chat-hosted-secret";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required (provision Neon first)");

const stamp = Date.now();
const WORKSPACE = `ws-${stamp}`;
const USER = `user-${stamp}`;
const CHANNEL = `channel-${stamp}`;

export async function runChatHostedE2e(): Promise<void> {
  const storage = postgresStorage({ connectionString: url as string });
  const realtime = inProcessRealtime();
  const sql = postgres(url as string, { max: 1 });
  let listener: ReturnType<ReturnType<typeof createChatServer>["listen"]> | null = null;

  try {
    const server = createChatServer({ db: url as string, secret: SECRET, storage, realtime });
    listener = server.listen(0);
    const baseUrl = await baseUrlFor(listener);
    const token = issueBearerToken({ secret: SECRET, userId: USER, ownerId: WORKSPACE });
    const subscribeSource = {
      subscribe: (buckets: string[], onMessage: (message: string) => void) =>
        realtime.subscribe(buckets, { send: onMessage }),
    };

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
      const rows = await sql<{ count: number }[]>`
        select count(*)::int as count from channel_members
        where channel_id = ${CHANNEL} and user_id = ${USER}`;
      return rows[0]?.count === 1;
    });
    assert(true, "createChannel persisted channel + membership to Neon");
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

    deviceA.mutate.sendMessage({ id: `m1-${stamp}`, channelId: CHANNEL, body: "hello over Neon" });
    await waitFor(() => deviceB.messages.toArray.some((m) => m.id === `m1-${stamp}`));
    assert(
      channelTimeline(deviceB.messages.toArray, CHANNEL).at(-1)?.body === "hello over Neon",
      "message sent on A syncs to B through hosted Neon",
    );
    const persisted = await sql<{ count: number }[]>`
      select count(*)::int as count from messages where id = ${`m1-${stamp}`}`;
    assert(persisted[0]?.count === 1, "message is durably persisted in Neon");

    deviceA.mutate.sendMessage({ id: `m2-${stamp}`, channelId: CHANNEL, body: "second" });
    await waitFor(
      () =>
        channelTimeline(deviceB.messages.toArray, CHANNEL)
          .map((m) => m.id)
          .join(",") === `m1-${stamp},m2-${stamp}`,
    );
    assert(true, "B converges in total order over the hosted stack");

    await Promise.all([deviceA.dispose(), deviceB.dispose()]);
    console.log(`\nCHAT-HOSTED-E2E: PASS ✅  (Neon db=chat, channel=${CHANNEL})`);
  } finally {
    if (listener) await closeServer(listener);
    await sql.end();
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✅ ${message}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for hosted chat convergence");
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
  runChatHostedE2e()
    .then(() => process.exit(0)) // Neon's postgres-js pool keeps the loop alive; exit explicitly
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
