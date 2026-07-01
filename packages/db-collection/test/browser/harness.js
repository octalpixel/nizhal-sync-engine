import {
  browserCoordinator,
  browserOnlineGate,
  localStorageMeta,
  localStorageOutbox,
} from "/dist/client-group-browser.js";
// Browser cross-tab harness — plain JS, native ES modules straight from the tsc build (no bundler).
// Served to two Chromium tabs at the same origin (driven via Argent). Uses the REAL browser coordinator
// (Web Locks + BroadcastChannel) + a shared localStorage outbox, and a fake "server" in localStorage that
// records which TAB pushed each write — so we can prove a follower tab's write was flushed by the leader.
import { openNizhalClientGroup } from "/dist/client-group.js";

const tab = new URLSearchParams(location.search).get("tab") ?? "unknown";
const ls = localStorage;

const echo = {
  getLastMutationId: () => Number(ls.getItem("nz-server:last") ?? "0"),
  push: async (m) => {
    if (m.args === "follower-lost" && !ls.getItem("nz-server:failed:follower-lost")) {
      ls.setItem("nz-server:failed:follower-lost", "1");
      throw new Error("push failed: 503 injected");
    }
    const applied = JSON.parse(ls.getItem("nz-server:applied") ?? "[]");
    if (!applied.some((a) => a.cmid === m.clientMutationId)) {
      applied.push({ cmid: m.clientMutationId, byTab: tab, mutationID: m.mutationID });
      ls.setItem("nz-server:applied", JSON.stringify(applied));
      ls.setItem("nz-server:last", String(m.mutationID ?? 0));
    }
    return { accepted: true, lastMutationId: Number(ls.getItem("nz-server:last") ?? "0") };
  },
};

const coord = browserCoordinator("demo-group");
const group = openNizhalClientGroup({
  echo,
  outbox: localStorageOutbox("nz-cg-outbox:"),
  meta: localStorageMeta("nz-cg-meta:"),
  coordinator: coord,
  online: browserOnlineGate(),
  clientID: "browser-device",
  retryDelayMs: 30,
});

window.cgEnqueue = (cmid, body) => group.enqueue(cmid, { name: "sendMessage", args: body });
window.cgIsLeader = () => coord.isLeader();
window.cgApplied = () => JSON.parse(ls.getItem("nz-server:applied") ?? "[]");
window.cgPending = () => group.pendingCount();
window.__cgTab = tab;
window.__cgReady = true;
