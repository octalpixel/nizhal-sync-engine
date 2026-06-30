// Hosted-infra smoke: Tabkeep server backed by hosted Neon (pull/push/storage) with realtime
// fan-out to the deployed Cloudflare Worker DO. Same wiring intended for the Vercel serverless
// deploy — proven locally first against the real hosted dependencies.
import { issueBearerToken } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { cloudflareHttpRealtime } from "@nizhal/server/adapters/cloudflare/realtime";
import { createTabkeepServer } from "../src/server.js";

const PORT = Number(process.env.PORT ?? 4521);
const SECRET = process.env.NIZHAL_JWT_SECRET ?? "dev-secret";
const PUBLISH_SECRET = process.env.NIZHAL_PUBLISH_SECRET ?? "pub-secret";
const WORKER = process.env.NIZHAL_WORKER_URL ?? "http://127.0.0.1:8787";
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error("DATABASE_URL required");

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

const listener = server.listen(PORT);
console.log(`Tabkeep Neon server on http://127.0.0.1:${PORT} → worker ${WORKER}`);
process.once("SIGINT", () => listener.close(() => process.exit(0)));
process.once("SIGTERM", () => listener.close(() => process.exit(0)));
