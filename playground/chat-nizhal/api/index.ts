// Vercel serverless entry for the chat server: postgresStorage -> Neon (pooled), cloudflareHttpRealtime
// -> the dedicated chat Worker. Exposed as a Node (req,res) handler via getRequestListener.
import { getRequestListener } from "@hono/node-server";
import { issueBearerToken } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { cloudflareHttpRealtime } from "@nizhal/server/adapters/cloudflare/realtime";
import { createChatServer } from "../src/server.js";

const SECRET = process.env.NIZHAL_JWT_SECRET as string;
const DB = process.env.DATABASE_URL as string;
const WORKER = process.env.NIZHAL_WORKER_URL as string;
const PUBLISH_SECRET = process.env.NIZHAL_PUBLISH_SECRET as string;
const WORKSPACE = "demo-workspace";

const storage = postgresStorage({ connectionString: DB });
const realtime = cloudflareHttpRealtime({
  publishUrl: `${WORKER}/_nizhal/publish`,
  publishSecret: PUBLISH_SECRET,
});
const server = createChatServer({ db: DB, secret: SECRET, storage, realtime, cors: true });

server.app.get("/demo/session", (c) => {
  const user = c.req.query("user") ?? "ada";
  return c.json({
    userId: user,
    workspaceId: WORKSPACE,
    channelIds: ["general"],
    token: issueBearerToken({
      secret: SECRET,
      userId: user,
      ownerId: WORKSPACE,
      expiresInSec: 86_400,
    }),
  });
});

export default getRequestListener(server.app.fetch);
