// Harder adversarial cases vs the LIVE hosted xid8 stack — the ones most likely to expose a horizon bug.
const BASE = process.env.RT_BASE || "https://nizhal-chat.vercel.app";
const WS = "demo-workspace";
const stamp = Date.now();
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(user) {
  const r = await fetch(`${BASE}/demo/session?user=${user}`);
  return (await r.json()).token;
}
async function push(token, mutations) {
  const r = await fetch(`${BASE}/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ mutations }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function pullOnce(token, cursor) {
  const r = await fetch(`${BASE}/sync/pull`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ cursor }),
  });
  return r.json();
}
async function drain(token, channelId, into) {
  let cursor = "";
  for (let i = 0; i < 80; i++) {
    const j = await pullOnce(token, cursor);
    const t = (j.changed || []).find((c) => c.table === "messages");
    for (const m of t?.rows || []) if (m.channel_id === channelId) into.add(m.id);
    if (!j.hasMore) break;
    cursor = j.cursor;
  }
}

const results = [];
const rec = (n, p, d) => {
  results.push({ n, p });
  log(`${p ? "✅" : "🔴"} ${n} — ${d}`);
};

async function main() {
  log(`hard red-team target: ${BASE}\n`);
  const author = await session("hard-author");
  const channelId = `hard-${stamp}`;
  await push(author, [
    {
      name: "createChannel",
      args: { id: channelId, workspaceId: WS, name: "hard" },
      clientMutationId: `cc-${stamp}`,
    },
  ]);

  // ── RT-4: continuous reader following the cursor WHILE a writer streams (jittered) ──
  // The horizon must never let the reader's cursor jump past an in-flight write → no permanent skip.
  const W = 80;
  const writerIds = Array.from({ length: W }, (_, i) => `w-${stamp}-${i}`);
  const seenLive = new Set();
  let readerCursor = "";
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      const j = await pullOnce(author, readerCursor);
      const t = (j.changed || []).find((c) => c.table === "messages");
      for (const m of t?.rows || []) if (m.channel_id === channelId) seenLive.add(m.id);
      readerCursor = j.cursor ?? readerCursor;
      await sleep(40);
    }
  })();
  // writer streams with random interleave so commits land between the reader's pulls
  for (let i = 0; i < W; i++) {
    push(author, [
      {
        name: "sendMessage",
        args: { id: writerIds[i], channelId, body: `w${i}` },
        clientMutationId: writerIds[i],
      },
    ]);
    await sleep(15 + Math.floor((i * 7919) % 35)); // deterministic jitter 15–50ms
  }
  await sleep(2500); // let the live reader catch up
  stop = true;
  await reader;
  // belt-and-suspenders final drain (anything the live reader could have caught, a full drain must)
  await drain(author, channelId, seenLive);
  const liveGot = writerIds.filter((id) => seenLive.has(id)).length;
  rec(
    "RT-4 continuous reader vs streaming writer (no permanent skip)",
    liveGot === W,
    `reader saw ${liveGot}/${W} streamed messages (skipped: ${W - liveGot})`,
  );

  // ── RT-5: cross-actor concurrent storm — 4 members hammer the same channel at once ──
  const users = ["m1", "m2", "m3", "m4"];
  const toks = await Promise.all(users.map(session));
  await Promise.all(
    toks.map((t, i) =>
      push(t, [
        {
          name: "joinChannel",
          args: { workspaceId: WS, channelId },
          clientMutationId: `j-${stamp}-${i}`,
        },
      ]),
    ),
  );
  const per = 25;
  const crossIds = [];
  const pushes = [];
  toks.forEach((t, ui) => {
    for (let k = 0; k < per; k++) {
      const id = `x-${stamp}-${ui}-${k}`;
      crossIds.push(id);
      pushes.push(
        push(t, [
          {
            name: "sendMessage",
            args: { id, channelId, body: `${ui}:${k}` },
            clientMutationId: id,
          },
        ]),
      );
    }
  });
  const cross = await Promise.all(pushes);
  const ok = cross.filter((r) => r.status === 200).length;
  const seenCross = new Set();
  await drain(author, channelId, seenCross);
  const crossGot = crossIds.filter((id) => seenCross.has(id)).length;
  rec(
    "RT-5 cross-actor concurrent storm (4 writers, lock-free no-loss)",
    crossGot === crossIds.length && ok === cross.length,
    `${ok}/${cross.length} pushes 200, ${crossGot}/${crossIds.length} messages present (lost: ${crossIds.length - crossGot})`,
  );

  log("\n──────── HARD RED-TEAM SUMMARY ────────");
  for (const r of results) log(`${r.p ? "PASS" : "FAIL"}  ${r.n}`);
  log(`\n${results.every((r) => r.p) ? "ALL HARD CASES SURVIVED ✅" : "🔴 A HARD CASE BROKE"}`);
  process.exit(results.every((r) => r.p) ? 0 : 2);
}
main().catch((e) => {
  console.error("harness error:", e.message);
  process.exit(1);
});
