export {}; // ensure module scope for top-level await
// Isolate the hosted realtime path: (1) does a WS connect+authorize to the Worker DO room?
// (2) does a correctly-formatted publish (?bucket=) reach the DO and broadcast a repull?
const WORKER = process.env.WORKER_URL as string; // https://...workers.dev
const URL = process.env.TARGET_URL as string;
const PUBLISH_SECRET = process.env.NIZHAL_PUBLISH_SECRET as string;
const token = ((await (await fetch(`${URL}/demo/session`)).json()) as { token: string }).token;

const wsUrl = `${WORKER.replace("https://", "wss://")}/parties/nizhal-bucket/shop-1?token=${encodeURIComponent(token)}`;
console.log("connecting:", wsUrl.replace(/token=[^&]+/, "token=***"));
const ws = new WebSocket(wsUrl);
let opened = false;
ws.onopen = () => {
  opened = true;
  console.log("WS OPEN");
};
ws.onerror = (e) => console.log("WS ERROR", (e as { message?: string }).message ?? "");
ws.onclose = (e) =>
  console.log("WS CLOSE", (e as { code?: number }).code, (e as { reason?: string }).reason ?? "");
ws.onmessage = (e) => console.log("WS MESSAGE:", String((e as { data: unknown }).data));

await new Promise((r) => setTimeout(r, 2500));
console.log("opened?", opened);

console.log("publishing (?bucket=shop-1)...");
const res = await fetch(`${WORKER}/_nizhal/publish?bucket=shop-1`, {
  method: "POST",
  headers: { authorization: `Bearer ${PUBLISH_SECRET}` },
});
console.log("publish status:", res.status, await res.text());

await new Promise((r) => setTimeout(r, 3000));
ws.close();
process.exit(0);
