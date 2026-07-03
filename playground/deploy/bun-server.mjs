// Bun entry — same domain, same config, only the runtime WS adapter differs. HTTP already runs on any
// runtime via `app.fetch`; the injectable `createWebSocket` factory makes realtime portable too.
// Run: `bun run bun-server.mjs`.
import { createNizhalServer } from "@nizhal/server";
import { createBunWebSocket } from "hono/bun";
import { ensureTable, serverConfig, syncRules } from "./domain.mjs";

const config = serverConfig();
await ensureTable(config.storage);
await config.storage.provision({ schema: {}, syncRules });

const bun = createBunWebSocket();
const server = createNizhalServer({ ...config, createWebSocket: () => bun });
await server.provisionRealtime(); // no .listen() on Bun — install the realtime triggers ourselves

const port = Number(process.env.PORT ?? 4720);
Bun.serve({ port, fetch: server.app.fetch, websocket: server.webSocket.websocket });
console.log(`nizhal deploy (Bun) → :${port}`);
