// Host-agnostic smoke test — points at a RUNNING Nizhal server (Node container, Bun, or a hosted URL)
// and exercises: HTTP push/pull, WebSocket realtime (the /sync/stream poke), and bearer auth (positive
// + negative). No client SQLite — raw HTTP + WebSocket, so it works against any deployment.
import { issueBearerToken } from "@nizhal/server";

const URL = process.env.SERVER_URL ?? "http://127.0.0.1:4700";
const SECRET = process.env.JWT_SECRET ?? "dev-secret";
const ROOM = `room-${Math.floor(Date.now() / 1000) % 100000}`;
const token = issueBearerToken({ userId: "u1", ownerId: ROOM, secret: SECRET });
const authHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const CLIENT = `cli-${ROOM}`; // unique per run so a shared DB doesn't dedupe across runs
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const push = (id, body, mutationID) =>
  fetch(`${URL}/sync/push`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      mutations: [
        {
          name: "postMessage",
          args: { id, body },
          clientMutationId: `${ROOM}-${id}`,
          clientID: CLIENT,
          mutationID,
        },
      ],
    }),
  });

async function main() {
  // auth: no token → 401
  const noAuth = await fetch(`${URL}/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mutations: [] }),
  });
  check(
    "auth: unauthenticated push is rejected (401)",
    noAuth.status === 401,
    `status=${noAuth.status}`,
  );

  const M1 = `${ROOM}-m1`;
  const M2 = `${ROOM}-m2`;

  // HTTP push (authenticated)
  const p1 = await push(M1, "hello over http", 1).then((r) => r.json());
  check(
    "HTTP push applies a mutation",
    p1.applied?.includes(M1) || p1.ok !== false,
    JSON.stringify(p1).slice(0, 80),
  );

  // HTTP pull → sees M1
  const pull = await fetch(`${URL}/sync/pull`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ cursor: "", deviceId: CLIENT }),
  }).then((r) => r.json());
  const pulledIds = (pull.changed ?? []).flatMap((c) => c.rows.map((r) => r.id));
  check(
    "HTTP pull returns the written row",
    pulledIds.includes(M1),
    `ids=${JSON.stringify(pulledIds)}`,
  );

  // WebSocket realtime: connect, then a write must produce a repull poke
  const wsUrl = `${URL.replace(/^http/, "ws")}/sync/stream?token=${encodeURIComponent(token)}&bucket=${ROOM}`;
  const frames = [];
  const ws = new WebSocket(wsUrl);
  const opened = await new Promise((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("error", () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  check("WebSocket /sync/stream upgrade succeeds", opened === true);
  ws.addEventListener("message", (e) => frames.push(String(e.data)));
  await new Promise((r) => setTimeout(r, 500));

  await push(M2, "hello over ws", 2);
  let gotPoke = false;
  for (let i = 0; i < 60 && !gotPoke; i += 1) {
    if (frames.some((f) => f === `repull:${ROOM}`)) gotPoke = true;
    else await new Promise((r) => setTimeout(r, 100));
  }
  check(
    "WebSocket realtime delivers a repull poke on a write",
    gotPoke,
    `frames=${JSON.stringify(frames.slice(0, 4))}`,
  );
  ws.close();

  const passed = results.filter(Boolean).length;
  console.log(`\n==== ${passed}/${results.length} PASS (${URL}) ====`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
