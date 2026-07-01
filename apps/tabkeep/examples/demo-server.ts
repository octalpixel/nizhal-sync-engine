import { PGlite } from "@electric-sql/pglite";
import { issueBearerToken } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { TABKEEP_DDL, tabkeepSchema } from "../src/schema.js";
import { createTabkeepServer } from "../src/server.js";
import { tabkeepSyncRules } from "../src/sync-rules.js";

const PORT = 4521;
const SECRET = "tabkeep-local-demo-secret";
const SHOP_ID = "shop-1";
const USER_ID = "user-1";

const db = new PGlite();
const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
await db.exec(TABKEEP_DDL);
await storage.provision({ schema: tabkeepSchema, syncRules: tabkeepSyncRules });

// CORS on so cross-origin browser clients (e.g. the Expo web app on :8081) can reach this API.
const server = createTabkeepServer({
  db: "postgres://unused",
  secret: SECRET,
  storage,
  cors: true,
});
server.app.get("/demo/session", (context) =>
  context.json({
    shopId: SHOP_ID,
    userId: USER_ID,
    // Long-lived for the local demo so a long-running tab/app session doesn't 401 mid-demo.
    token: issueBearerToken({
      secret: SECRET,
      userId: USER_ID,
      ownerId: SHOP_ID,
      expiresInSec: 86_400,
    }),
  }),
);

const listener = server.listen(PORT);
console.log(`Tabkeep demo server listening on http://127.0.0.1:${PORT}`);

async function close() {
  await new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolve()));
  });
  await db.close();
}

process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
