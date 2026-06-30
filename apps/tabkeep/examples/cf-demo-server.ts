// Tabkeep demo server wired to CLOUDFLARE realtime (not in-process).
// Data path (pull/push) is this Node + PGlite server; realtime fan-out goes through the CF worker's
// Durable Object: on commit we POST /_nizhal/publish to the worker → DO broadcasts repull → browsers.
// Run alongside `wrangler dev` (the worker) — see cf-two-browser run notes.
import { PGlite } from "@electric-sql/pglite";
import { issueBearerToken } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
// Node-safe entry: the bridge POSTs to the worker; it does NOT pull in the workerd-only DO.
import { cloudflareHttpRealtime } from "@nizhal/server/adapters/cloudflare/realtime";
import { TABKEEP_DDL, tabkeepSchema } from "../src/schema.js";
import { createTabkeepServer } from "../src/server.js";
import { tabkeepSyncRules } from "../src/sync-rules.js";

const PORT = 4521;
const SECRET = process.env.NIZHAL_JWT_SECRET ?? "dev-secret";
const PUBLISH_SECRET = process.env.NIZHAL_PUBLISH_SECRET ?? "pub-secret";
const WORKER = process.env.NIZHAL_WORKER_URL ?? "http://127.0.0.1:8787";
const SHOP_ID = "shop-1";
const USER_ID = "user-1";

const db = new PGlite();
const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
await db.exec(TABKEEP_DDL);
await storage.provision({ schema: tabkeepSchema, syncRules: tabkeepSyncRules });

const realtime = cloudflareHttpRealtime({
  publishUrl: `${WORKER}/_nizhal/publish`,
  publishSecret: PUBLISH_SECRET,
});
const server = createTabkeepServer({ db: "postgres://unused", secret: SECRET, storage, realtime });
server.app.get("/demo/session", (context) =>
  context.json({
    shopId: SHOP_ID,
    userId: USER_ID,
    token: issueBearerToken({ secret: SECRET, userId: USER_ID, ownerId: SHOP_ID }),
  }),
);

const listener = server.listen(PORT);
console.log(`Tabkeep CF demo server on http://127.0.0.1:${PORT} → worker ${WORKER}`);
process.once("SIGINT", () => void listener.close(() => process.exit(0)));
process.once("SIGTERM", () => void listener.close(() => process.exit(0)));
