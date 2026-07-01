// Browser harness for the real cross-tab test. Bundled to harness.js and loaded by two Playwright tabs
// at the same origin. Uses the REAL browser coordinator (Web Locks + BroadcastChannel) + a localStorage
// shared outbox, and a fake "server" (also in localStorage, so both tabs + the test can read it) that
// records which TAB pushed each write — so we can prove a follower tab's write was flushed by the leader.
import type { Mutation } from "@nizhal/kernel";
import {
  browserCoordinator,
  browserOnlineGate,
  localStorageMeta,
  localStorageOutbox,
} from "../../src/client-group-browser.js";
import { openNizhalClientGroup } from "../../src/client-group.js";
import type { NizhalClient, NizhalPushResult } from "../../src/client.js";

declare global {
  interface Window {
    __TAB__: string;
    cgEnqueue: (cmid: string, body: string) => Promise<void>;
    cgIsLeader: () => boolean;
    cgApplied: () => Array<{ cmid: string; byTab: string; mutationID?: number }>;
    cgPending: () => Promise<number>;
  }
}

const tab = window.__TAB__ ?? "unknown";
const ls = globalThis.localStorage;

// Fake server in localStorage: idempotent, fails a "follower-lost" body once (transient), and records the
// pushing tab. Only the leader ever pushes, so there is no cross-tab race on the applied log.
const echo = {
  getLastMutationId: () => Number(ls.getItem("nz-server:last") ?? "0"),
  push: async (m: Mutation): Promise<NizhalPushResult> => {
    if (m.args === "follower-lost" && !ls.getItem("nz-server:failed:follower-lost")) {
      ls.setItem("nz-server:failed:follower-lost", "1");
      throw new Error("push failed: 503 injected");
    }
    const applied = JSON.parse(ls.getItem("nz-server:applied") ?? "[]") as Array<{
      cmid: string;
      byTab: string;
      mutationID?: number;
    }>;
    if (!applied.some((a) => a.cmid === m.clientMutationId)) {
      applied.push({ cmid: m.clientMutationId, byTab: tab, mutationID: m.mutationID });
      ls.setItem("nz-server:applied", JSON.stringify(applied));
      ls.setItem("nz-server:last", String(m.mutationID ?? 0));
    }
    return { accepted: true, lastMutationId: Number(ls.getItem("nz-server:last") ?? "0") };
  },
} as unknown as NizhalClient;

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
