import {
  type NizhalPullRequest,
  type NizhalPullResponse,
  type NizhalPushRequest,
  type NizhalPushResponse,
  type NizhalSyncTarget,
  NizhalSyncTargetError,
} from "../../src/index.js";

// P3 chaos rig (T12): a fault-injecting NizhalSyncTarget that wraps the real transport and, driven by
// a SEEDED prng, drops / delays / duplicates / 5xx's pull and push. Every run is reproducible from its
// seed, so a soak failure is replayable. The faults are all transient + retriable: the invariant under
// test is that the engine (idempotent replay, contiguous-sequence resync, one-tx apply) converges
// anyway — no duplicate, no loss.

/** mulberry32 — a tiny deterministic PRNG. Same seed → same fault sequence. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChaosConfig {
  rng: () => number;
  /** Probability a push fails with a retriable error. */
  pushFailRate?: number;
  /** Probability a pull fails with a retriable error. */
  pullFailRate?: number;
  /** Probability a push is delivered to the server TWICE (tests idempotency). */
  duplicateRate?: number;
  /** Max random latency (ms) added before delegating. */
  delayMaxMs?: number;
  /**
   * When a push fault fires: "after" delivers to the server first, THEN throws (a lost ack / 5xx after
   * the mutation applied — the retry must dedupe); "before" throws without delivering (pure retry).
   * "mix" chooses per-call by the prng. Default "mix".
   */
  pushFailMode?: "before" | "after" | "mix";
}

export interface ChaosStats {
  pulls: number;
  pullFailures: number;
  pushes: number;
  pushFailures: number;
  duplicates: number;
}

export interface ChaosTarget extends NizhalSyncTarget {
  readonly stats: ChaosStats;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wrap any NizhalSyncTarget with seeded fault injection. */
export function chaosSyncTarget(base: NizhalSyncTarget, config: ChaosConfig): ChaosTarget {
  const stats: ChaosStats = {
    pulls: 0,
    pullFailures: 0,
    pushes: 0,
    pushFailures: 0,
    duplicates: 0,
  };
  const delayMax = config.delayMaxMs ?? 0;
  const maybeDelay = async () => {
    if (delayMax > 0) await sleep(Math.floor(config.rng() * delayMax));
  };
  const retriable = (why: string) =>
    new NizhalSyncTargetError(`chaos: ${why}`, { retriable: true });

  return {
    stats,
    async pull(request: NizhalPullRequest): Promise<NizhalPullResponse> {
      stats.pulls += 1;
      await maybeDelay();
      if (config.rng() < (config.pullFailRate ?? 0)) {
        stats.pullFailures += 1;
        throw retriable("pull dropped");
      }
      return base.pull(request);
    },
    async push(request: NizhalPushRequest): Promise<NizhalPushResponse> {
      stats.pushes += 1;
      await maybeDelay();

      const fail = config.rng() < (config.pushFailRate ?? 0);
      const mode =
        config.pushFailMode === "mix" || config.pushFailMode === undefined
          ? config.rng() < 0.5
            ? "before"
            : "after"
          : config.pushFailMode;

      if (fail && mode === "before") {
        stats.pushFailures += 1;
        throw retriable("push dropped before delivery");
      }

      const response = await base.push(request);

      // Duplicate delivery: the server must dedupe the second copy (idempotent claimMutation).
      if (config.rng() < (config.duplicateRate ?? 0)) {
        stats.duplicates += 1;
        await base.push(request).catch(() => {});
      }

      if (fail && mode === "after") {
        // The mutation applied on the server but the ack is "lost": the client retries the same
        // clientMutationId and the server returns a duplicate — no double-apply.
        stats.pushFailures += 1;
        throw retriable("push ack lost after apply");
      }
      return response;
    },
  };
}
