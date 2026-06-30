// Long-running chat server for the web UI: hosted Neon persistence + in-process realtime (the server's
// /sync/stream pushes to connected browser tabs) + CORS + per-user demo tokens. Seeds one `general`
// channel with two members so two browser tabs (?user=ada / ?user=lin) can chat immediately.
// Run: DATABASE_URL=<neon> pnpm --filter chat-nizhal exec tsx examples/dev-server.ts
import { issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import postgres from "postgres";
import { createChatClient } from "../src/client.js";
import { createChatServer } from "../src/server.js";

const PORT = Number(process.env.PORT ?? 4600);
const SECRET = process.env.NIZHAL_JWT_SECRET ?? "chat-local-demo-secret";
const WORKSPACE = "demo-workspace";
const CHANNEL = "general";
const MEMBERS = ["ada", "lin"];
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required (provision Neon first)");

const storage = postgresStorage({ connectionString: url });
const realtime = inProcessRealtime();
const server = createChatServer({ db: url, secret: SECRET, storage, realtime, cors: true });

// /demo/session?user=ada → a long-lived token for that user in the demo workspace.
server.app.get("/demo/session", (c) => {
  const user = c.req.query("user") ?? MEMBERS[0];
  return c.json({
    userId: user,
    workspaceId: WORKSPACE,
    channelIds: [CHANNEL],
    token: issueBearerToken({
      secret: SECRET,
      userId: user,
      ownerId: WORKSPACE,
      expiresInSec: 86_400,
    }),
  });
});

const listener = server.listen(PORT);
await new Promise<void>((resolve) => listener.once("listening", () => resolve()));

// Idempotent seed: create `general` (as the first member) + add the rest. createChannel/joinChannel
// write to the WORKSPACE bucket, which every workspace member owns — so this is allowed.
const sql = postgres(url, { max: 1 });
const existing = await sql<{ count: number }[]>`
  select count(*)::int as count from channels where id = ${CHANNEL}`;
if (existing[0]?.count === 0) {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const seedToken = (user: string) =>
    issueBearerToken({ secret: SECRET, userId: user, ownerId: WORKSPACE, expiresInSec: 86_400 });
  const creator = await createChatClient({
    server: baseUrl,
    token: seedToken(MEMBERS[0] as string),
    userId: MEMBERS[0] as string,
    workspaceId: WORKSPACE,
    channelIds: [],
  });
  creator.mutate.createChannel({ id: CHANNEL, workspaceId: WORKSPACE, name: "general" });
  for (const user of MEMBERS.slice(1)) {
    creator.mutate.joinChannel({ workspaceId: WORKSPACE, channelId: CHANNEL, userId: user });
  }
  await creator.waitForIdle();
  await creator.dispose();
  console.log(`seeded #${CHANNEL} with members: ${MEMBERS.join(", ")}`);
}
await sql.end();

console.log(
  `Chat dev server on http://127.0.0.1:${PORT}  (Neon-backed, realtime via /sync/stream)`,
);
console.log(`  open the web UI and visit ?user=ada and ?user=lin in two tabs`);

async function close() {
  await new Promise<void>((resolve, reject) =>
    listener.close((error?: Error) => (error ? reject(error) : resolve())),
  );
}
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
