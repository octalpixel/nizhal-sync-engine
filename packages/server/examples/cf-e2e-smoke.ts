// Real Cloudflare end-to-end smoke over `wrangler dev` (workerd + Durable Objects):
// a WS client connects to the per-bucket DO, the server hits the POST /_nizhal/publish bridge,
// and the client must receive the DO's `repull:<bucket>` broadcast. Proves server→DO→client.
//
// Run (started by run-cf-e2e.sh, which boots wrangler dev with the two secrets):
//   PORT=8787 NIZHAL_JWT_SECRET=dev-secret NIZHAL_PUBLISH_SECRET=pub-secret tsx cf-e2e-smoke.ts
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const PORT = process.env.PORT ?? "8787";
const JWT_SECRET = process.env.NIZHAL_JWT_SECRET ?? "dev-secret";
const PUBLISH_SECRET = process.env.NIZHAL_PUBLISH_SECRET ?? "pub-secret";
const AUTH_PORT = process.env.AUTH_PORT ?? "8790";
const BUCKET = "shop-1";
const HTTP = `http://127.0.0.1:${PORT}`;
// PartyServer routes /parties/<binding-kebab>/<room>; binding NizhalBucket → nizhal-bucket.
const WS_URL = `ws://127.0.0.1:${PORT}/parties/nizhal-bucket/${BUCKET}`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(userId: string): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({
    userId,
    ownerId: "owner-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${h}.${p}.${createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`;
}

async function main() {
  const authorizationServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${AUTH_PORT}`);
    const authorized =
      url.pathname === "/sync/realtime/authorize" &&
      url.searchParams.get("bucket") === BUCKET &&
      request.headers.authorization?.startsWith("Bearer ");
    response.writeHead(authorized ? 204 : 403).end();
  });
  await new Promise<void>((resolve) =>
    authorizationServer.listen(Number(AUTH_PORT), "127.0.0.1", resolve),
  );

  const token = mint("user-1");
  const peerToken = mint("user-2");
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  const peer = new WebSocket(`${WS_URL}?token=${encodeURIComponent(peerToken)}`);

  try {
    await Promise.all([waitForOpen(ws), waitForOpen(peer)]);
    console.log(`✅ two clients connected to DO room ${BUCKET} over workerd`);

    const pong = nextMessage(ws, (message) => message === "pong", "pong auto-response");
    ws.send("ping");
    await pong;
    console.log("✅ ping/pong auto-response configured on workerd");

    const typingFrame = 'typing:{"active":true}';
    const relayed = nextMessage(peer, (message) => message === typingFrame, "ephemeral relay");
    ws.send(typingFrame);
    await relayed;
    console.log("✅ ephemeral frame relayed verbatim without durable state");

    const got = nextMessage(ws, (message) => message.startsWith("repull:"), "repull broadcast");
    const forbidden = await fetch(`${HTTP}/_nizhal/publish?bucket=${BUCKET}`, { method: "POST" });
    if (forbidden.status !== 403)
      throw new Error(`unauthenticated publish should be 403, got ${forbidden.status}`);
    console.log("✅ unauthenticated publish rejected (403)");

    const res = await fetch(`${HTTP}/_nizhal/publish?bucket=${BUCKET}`, {
      method: "POST",
      headers: { authorization: `Bearer ${PUBLISH_SECRET}` },
    });
    if (res.status !== 204) throw new Error(`publish bridge returned ${res.status}`);
    console.log("✅ server→worker publish bridge accepted (204)");

    const message = await got;
    console.log(`✅ client received DO broadcast: "${message}"`);
    console.log(
      "\nCF E2E SMOKE PASSED ✅ (server → /_nizhal/publish → getServerByName → DO.repull → client)",
    );
  } finally {
    ws.close();
    peer.close();
    await new Promise<void>((resolve, reject) =>
      authorizationServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
main().catch((error) => {
  console.error(
    `\nCF E2E SMOKE FAILED ❌ ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 8_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("ws failed to open (auth?)"));
    });
  });
}

function nextMessage(
  socket: WebSocket,
  predicate: (message: string) => boolean,
  description: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      8_000,
    );
    socket.addEventListener("message", function onMessage(event) {
      const message = typeof event.data === "string" ? event.data : "";
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`ws error while waiting for ${description}`));
    });
  });
}
