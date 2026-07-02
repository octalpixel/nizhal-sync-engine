import { NizhalSyncTargetError } from "./sync-target.js";
import { NonRetriableError } from "./types.js";

export type PushFailureClass = "retriable" | "terminal";

// Parking a write (terminal) is data loss from the user's point of view — the optimistic local row stays
// visible but the write never reaches the server. So the bar for "terminal" is deliberately high: we park
// ONLY on a recognized, definitively-terminal client error (a malformed/forbidden request a blind retry
// cannot fix). Everything ambiguous — timeouts, conflicts, rate-limits, all 5xx, cold-start hiccups,
// unrecognized shapes — is retriable. This is RFC-011 F-A.
//
// Genuinely-terminal HTTP statuses: the request itself is wrong and re-sending it byte-for-byte fails the
// same way. NOT included: 408 (timeout), 409 (conflict — resolves on resync), 425 (too early),
// 429 (rate limit), all 5xx (server/transport) — every one of those is transient.
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

export function classifyPushError(error: unknown): PushFailureClass {
  if (error instanceof NizhalSyncTargetError) {
    return error.retriable ? "retriable" : "terminal";
  }
  if (error instanceof NonRetriableError) {
    return "terminal";
  }

  const message = error instanceof Error ? error.message : String(error);
  const causeMessage =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message} ${causeMessage}`;

  // Network / connectivity / timeout failures are always transient.
  if (
    /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network ?error|timed? ?out|aborted)\b/i.test(
      combined,
    )
  ) {
    return "retriable";
  }

  // Parse the HTTP status ONLY from the sync-target's "push failed: NNN ..." / "pull failed: NNN ..."
  // prefix — never from arbitrary digits in a response body. A body that happens to contain "400" must
  // not park the user's write (the old loose /\b(\d{3})\b/ match did exactly that).
  const statusMatch = combined.match(/(?:push|pull) failed:\s*(\d{3})\b/i);
  if (statusMatch) {
    return TERMINAL_STATUSES.has(Number(statusMatch[1])) ? "terminal" : "retriable";
  }

  // Unknown shape → retriable. We only park on a recognized terminal signal above.
  return "retriable";
}
