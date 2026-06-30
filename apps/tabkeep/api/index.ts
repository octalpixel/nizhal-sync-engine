// Vercel serverless entry for the Tabkeep data server. Same wiring proven in examples/neon-server.ts
// (postgresStorage -> Neon, cloudflareHttpRealtime -> deployed Worker), exposed as a Node (req,res)
// handler via @hono/node-server's getRequestListener (the same listener createNizhalServer.listen uses).
import { getRequestListener } from "@hono/node-server";
import { issueBearerToken } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { cloudflareHttpRealtime } from "@nizhal/server/adapters/cloudflare/realtime";
import { createTabkeepServer } from "../src/server.js";

const SECRET = process.env.NIZHAL_JWT_SECRET as string;
const DB = process.env.DATABASE_URL as string;
const WORKER = process.env.NIZHAL_WORKER_URL as string;
const PUBLISH_SECRET = process.env.NIZHAL_PUBLISH_SECRET as string;

const storage = postgresStorage({ connectionString: DB });
const realtime = cloudflareHttpRealtime({
  publishUrl: `${WORKER}/_nizhal/publish`,
  publishSecret: PUBLISH_SECRET,
});
const server = createTabkeepServer({ db: DB, secret: SECRET, storage, realtime, cors: true });
server.app.get("/demo/session", (c) =>
  c.json({
    shopId: "shop-1",
    userId: "user-1",
    token: issueBearerToken({
      secret: SECRET,
      userId: "user-1",
      ownerId: "shop-1",
      expiresInSec: 86_400,
    }),
  }),
);

export default getRequestListener(server.app.fetch);
