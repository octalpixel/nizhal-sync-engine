import type { NizhalClient } from "./client.js";
import type { PresenceEvent, PresenceMember, PresenceStateMap } from "./types.js";

export type { PresenceEvent, PresenceMember, PresenceMeta, PresenceStateMap } from "./types.js";

/** Track presence for a sync rule with an optional app payload. */
export function track(
  echo: NizhalClient,
  syncRule: string,
  payload?: Record<string, unknown>,
): void {
  echo.track(syncRule, payload);
}

/** Stop tracking presence for a sync rule. */
export function untrack(echo: NizhalClient, syncRule: string): void {
  echo.untrack(syncRule);
}

/** Current presence map for a sync rule: `{ [userId]: Meta[] }`. */
export function presenceState(echo: NizhalClient, syncRule: string): PresenceStateMap {
  return echo.presenceState(syncRule);
}

/** Subscribe to presence sync/join/leave events for a sync rule. */
export function onPresence(
  echo: NizhalClient,
  syncRule: string,
  handler: (event: PresenceEvent) => void,
): () => void {
  return echo.onPresence(syncRule, handler);
}

/** @deprecated Use `onPresence` with sync/join/leave events. */
export function subscribePresence(
  echo: NizhalClient,
  syncRule: string,
  cb: (members: PresenceMember[]) => void,
): () => void {
  return echo.onPresence(syncRule, () => {
    cb(presenceMembersFromState(echo.presenceState(syncRule)));
  });
}

/** @deprecated Use `presenceState`. */
export function presence(echo: NizhalClient, syncRule: string): PresenceMember[] {
  return presenceMembersFromState(echo.presenceState(syncRule));
}

function presenceMembersFromState(state: PresenceStateMap): PresenceMember[] {
  const members: PresenceMember[] = [];
  for (const [userId, metas] of Object.entries(state)) {
    const first = metas[0];
    const displayName =
      typeof first?.displayName === "string"
        ? first.displayName
        : typeof first?.display_name === "string"
          ? first.display_name
          : undefined;
    members.push({ userId, displayName });
  }
  return members;
}
