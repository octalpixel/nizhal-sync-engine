import { createServer } from "node:http";
import { createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import postgres from "postgres";
import { tabkeepMutators, tabkeepSyncRules } from "../src/domain";

// Local dev server for the tabkeep reference app over a REAL local Postgres (a throwaway dev DB —
// default `tabkeep_dev` on localhost; NEVER point this at a shared/prod database).
// Run: createdb tabkeep_dev && pnpm dev-server   (+ `npx expo start --web`)
const PORT = Number(process.env.PORT ?? 4521);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/tabkeep_dev";
const DEMO = { shopId: "demo-shop", userId: "demo-user", token: "demo-token" };

async function main() {
  const sql = postgres(DATABASE_URL, { max: 5, onnotice: () => {} });
  const storage = postgresStorage({ connectionString: DATABASE_URL });
  await sql.unsafe(`
    create table if not exists customers (
      id text primary key,
      shop_id text not null,
      name text not null,
      phone text,
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );
    create table if not exists ledger_entries (
      id text primary key,
      shop_id text not null,
      customer_id text not null,
      kind text not null,
      amount integer not null,
      note text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );
  `);
  await storage.provision({ schema: {}, syncRules: tabkeepSyncRules });
  await sql.end();

  const server = createNizhalServer({
    db: DATABASE_URL,
    schema: {},
    mutators: tabkeepMutators,
    syncRules: tabkeepSyncRules,
    auth: {
      async resolve(req: Request) {
        const header = req.headers.get("authorization") ?? "";
        if (header !== `Bearer ${DEMO.token}`) return null;
        return { userId: DEMO.userId, ownerId: DEMO.shopId };
      },
    },
    storage,
  });

  // Plain Node wrapper: CORS for the Expo web origin + the /demo/session bootstrap endpoint.
  // (No WS upgrade — the web client runs on interval pull in the local demo.)
  const httpServer = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.url?.startsWith("/demo/session")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(DEMO));
      return;
    }
    const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const init: RequestInit = {
        method: req.method ?? "GET",
        headers: req.headers as unknown as HeadersInit,
      };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      server.app
        .fetch(new Request(url, init))
        .then(async (response: Response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            if (!key.startsWith("access-control")) res.setHeader(key, value);
          });
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((error: unknown) => {
          res.statusCode = 500;
          res.end(String(error));
        });
    });
  });

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`tabkeep dev server → http://127.0.0.1:${PORT} (postgres: ${DATABASE_URL})`);
  });
}

void main();
