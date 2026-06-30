import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { NizhalAuth } from "@nizhal/server";
import { createNizhalServer } from "@nizhal/server";
import type { RealtimeAdapter } from "@nizhal/server/adapters";
import { postgresStorage } from "@nizhal/server/adapters";
import { smsReminderHandler } from "../src/jobs.js";
import { creditLedgerMutators } from "../src/mutators.js";
import { CREDIT_LEDGER_DDL, creditLedgerSchema } from "../src/schema.js";
import { creditLedgerSyncRules } from "../src/sync-rules.js";

export const TEST_SHOP_ID = "shop-1";
export const TEST_USER_ID = "user-1";
export const TEST_CUSTOMER_ID = "customer-1";

export const testAuth: NizhalAuth = {
  async resolve() {
    return { userId: TEST_USER_ID, ownerId: "owner-1", shopId: TEST_SHOP_ID };
  },
};

export interface CreditLedgerHarness {
  baseUrl: string;
  db: PGlite;
  realtime: RealtimeAdapter;
  close: () => void;
}

export async function createCreditLedgerHarness(): Promise<CreditLedgerHarness> {
  const db = new PGlite();
  const storage = postgresStorage({
    connectionString: "postgres://unused",
    client: db,
  });

  await db.exec(CREDIT_LEDGER_DDL);
  await storage.provision({ schema: creditLedgerSchema, syncRules: creditLedgerSyncRules });

  await db.exec(`
    insert into shops (id, name, owner_id) values ('${TEST_SHOP_ID}', 'Test Shop', 'owner-1');
    insert into shop_members (shop_id, user_id, role) values ('${TEST_SHOP_ID}', '${TEST_USER_ID}', 'owner');
    insert into customers (id, shop_id, name, phone, client_id)
      values ('${TEST_CUSTOMER_ID}', '${TEST_SHOP_ID}', 'Amara', '+94771234567', '${TEST_CUSTOMER_ID}');
  `);

  const realtime = inProcessRealtime();
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: creditLedgerSchema,
    mutators: creditLedgerMutators,
    syncRules: creditLedgerSyncRules,
    auth: testAuth,
    storage,
    realtime,
    jobs: { "sms-reminder": smsReminderHandler },
  });

  const listener = await serveFetch(server.app.fetch);
  return {
    baseUrl: listener.baseUrl,
    db,
    realtime,
    close: listener.close,
  };
}

export function inProcessRealtime(): RealtimeAdapter {
  const registry = new Map<string, Set<{ send: (data: string) => void }>>();
  return {
    publish(bucket) {
      const subs = registry.get(bucket);
      if (!subs) return;
      for (const socket of subs) socket.send(`repull:${bucket}`);
    },
    subscribe(buckets, socket) {
      for (const bucket of buckets) {
        let set = registry.get(bucket);
        if (!set) {
          set = new Set();
          registry.set(bucket, set);
        }
        set.add(socket);
      }
      return () => {
        for (const bucket of buckets) registry.get(bucket)?.delete(socket);
      };
    },
  };
}

export function serveFetch(fetchFn: typeof fetch): Promise<{ baseUrl: string; close: () => void }> {
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = `http://${host}${req.url ?? "/"}`;
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const init: RequestInit = { method, headers: req.headers as HeadersInit };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fetchFn(new Request(url, init))
        .then(async (response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((error: Error) => {
          res.statusCode = 500;
          res.end(error.message);
        });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
