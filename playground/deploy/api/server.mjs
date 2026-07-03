// Vercel serverless entry — the platform-agnostic proof. Vercel wants you to `export default` an
// http.Server built by @hono/node-server's serve(); NizhalServer.injectWebSocket() (the H1 fix)
// attaches the /sync/stream upgrade handler onto it. HTTP push/pull ride app.fetch as on any host.
//
// Serverless has NO persistent process, so two things a long-running listen() does for free must be
// done explicitly here: provisionRealtime() at cold start (install the pg_notify triggers), and
// draining the transactional outbox — that lives in the sibling api/drain.mjs, hit by a Vercel Cron.
//
// Realtime note: a WebSocket is pinned to one function instance for its lifetime (Fluid compute), and
// listenNotifyRealtime keeps that instance's LISTEN connection alive — so a push landing on ANY other
// instance's pg NOTIFY reaches the socket-holding instance. Requires a DIRECT (session-mode) Postgres
// URL (a transaction pooler drops LISTEN).
import { serve } from "@hono/node-server";
import { createNizhalServer } from "@nizhal/server";
import { ensureTable, serverConfig, syncRules } from "../domain.mjs";

const config = serverConfig();
await ensureTable(config.storage);
await config.storage.provision({ schema: {}, syncRules });

const server = createNizhalServer(config);
await server.provisionRealtime(); // listen() would do this; on serverless we call it at cold start

const httpServer = serve({ fetch: server.app.fetch });
server.injectWebSocket(httpServer);

export default httpServer;
