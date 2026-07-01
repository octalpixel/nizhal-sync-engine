// Real-browser cross-tab test for NizhalClientGroup: two tabs in one Chromium context (shared origin ⇒
// shared localStorage + real Web Locks + real BroadcastChannel). Proves Web Locks elects exactly one
// leader and that a write ENQUEUED IN THE FOLLOWER TAB is FLUSHED BY THE LEADER TAB — past a transient
// 503 — over the shared outbox. Run: node cross-tab.mjs (needs playwright + a chromium).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium } from "playwright";

const dir = dirname(fileURLToPath(import.meta.url));

// Bundle the TS harness (the REAL src/client-group{,-browser}.ts) into a browser ESM module at run time,
// so the test always exercises the current source and needs no committed build artifact.
await esbuild.build({
  entryPoints: [join(dir, "harness.ts")],
  bundle: true,
  format: "esm",
  outfile: join(dir, "harness.js"),
  logLevel: "silent",
});

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}
async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const server = createServer((req, res) => {
  const rel = normalize(req.url === "/" ? "/index.html" : req.url).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = readFileSync(join(dir, rel));
    res.setHeader("content-type", rel.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext(); // one context = shared origin storage across tabs
try {
  const a = await context.newPage();
  await a.addInitScript(() => {
    window.__TAB__ = "A";
  });
  await a.goto(url);
  const b = await context.newPage();
  await b.addInitScript(() => {
    window.__TAB__ = "B";
  });
  await b.goto(url);

  // Web Locks must elect exactly one leader across the two tabs.
  await waitFor(
    async () =>
      (await a.evaluate(() => window.cgIsLeader())) ||
      (await b.evaluate(() => window.cgIsLeader())),
  );
  const aLeader = await a.evaluate(() => window.cgIsLeader());
  const bLeader = await b.evaluate(() => window.cgIsLeader());
  assert(aLeader !== bLeader, `exactly one leader (A=${aLeader}, B=${bLeader})`);
  const leaderTab = aLeader ? "A" : "B";
  const leaderPage = aLeader ? a : b;
  const followerPage = aLeader ? b : a;
  console.log(`Web Locks elected leader: tab ${leaderTab}`);

  // Enqueue in the FOLLOWER tab (body "follower-lost" fails once → tests transient recovery), and a
  // separate write from the leader tab.
  await followerPage.evaluate(() => window.cgEnqueue("from-follower", "follower-lost"));
  await leaderPage.evaluate(() => window.cgEnqueue("from-leader", "leader-kept"));

  await waitFor(async () => (await a.evaluate(() => window.cgApplied())).length === 2);
  const applied = await a.evaluate(() => window.cgApplied());

  assert(
    applied
      .map((x) => x.cmid)
      .sort()
      .join(",") === "from-follower,from-leader",
    `both writes delivered: ${JSON.stringify(applied)}`,
  );
  const followerWrite = applied.find((x) => x.cmid === "from-follower");
  assert(
    followerWrite.byTab === leaderTab,
    `the follower's write must be flushed BY THE LEADER TAB (${leaderTab}); got ${followerWrite.byTab}`,
  );
  assert((await followerPage.evaluate(() => window.cgPending())) === 0, "shared outbox drained");

  console.log(
    `✅ CROSS-TAB BROWSER TEST PASSED — follower write flushed by leader tab ${leaderTab}, past a transient 503`,
  );
  console.log(JSON.stringify(applied, null, 2));
} finally {
  await browser.close();
  server.close();
}
