import type { PresenceDiff, PresenceMeta, PresenceStateMap } from "./types.js";

export function syncPresenceState(
  current: PresenceStateMap,
  newState: PresenceStateMap,
  onJoin: (key: string, metas: PresenceMeta[]) => void,
  onLeave: (key: string, metas: PresenceMeta[]) => void,
): PresenceStateMap {
  const joins: PresenceStateMap = {};
  const leaves: PresenceStateMap = {};

  for (const key of new Set([...Object.keys(current), ...Object.keys(newState)])) {
    const currentMetas = current[key] ?? [];
    const newMetas = newState[key] ?? [];
    const currentRefs = new Set(currentMetas.map((meta) => meta.presence_ref));
    const newRefs = new Set(newMetas.map((meta) => meta.presence_ref));

    const joined = newMetas.filter((meta) => !currentRefs.has(meta.presence_ref));
    const left = currentMetas.filter((meta) => !newRefs.has(meta.presence_ref));
    if (joined.length > 0) joins[key] = joined;
    if (left.length > 0) leaves[key] = left;
  }

  for (const [key, metas] of Object.entries(joins)) onJoin(key, metas);
  for (const [key, metas] of Object.entries(leaves)) onLeave(key, metas);
  return newState;
}

export function syncPresenceDiff(
  current: PresenceStateMap,
  diff: PresenceDiff,
  onJoin: (key: string, metas: PresenceMeta[]) => void,
  onLeave: (key: string, metas: PresenceMeta[]) => void,
): PresenceStateMap {
  const next = clonePresenceState(current);

  for (const [key, metas] of Object.entries(diff.leaves)) {
    const existing = next[key];
    if (!existing) continue;
    const leaveRefs = new Set(metas.map((meta) => meta.presence_ref));
    const remaining = existing.filter((meta) => !leaveRefs.has(meta.presence_ref));
    if (remaining.length === 0) delete next[key];
    else next[key] = remaining;
    onLeave(key, metas);
  }

  for (const [key, metas] of Object.entries(diff.joins)) {
    const existing = next[key] ?? [];
    const refs = new Set(existing.map((meta) => meta.presence_ref));
    const merged = [...existing];
    for (const meta of metas) {
      if (!refs.has(meta.presence_ref)) merged.push(meta);
    }
    next[key] = merged;
    onJoin(key, metas);
  }

  return next;
}

export function mergeBucketPresence(
  byBucket: Map<string, PresenceStateMap>,
  buckets: string[],
): PresenceStateMap {
  const merged: PresenceStateMap = {};
  for (const bucket of buckets) {
    const state = byBucket.get(bucket);
    if (!state) continue;
    for (const [key, metas] of Object.entries(state)) {
      const existing = merged[key] ?? [];
      const refs = new Set(existing.map((meta) => meta.presence_ref));
      const next = [...existing];
      for (const meta of metas) {
        if (!refs.has(meta.presence_ref)) next.push(meta);
      }
      merged[key] = next;
    }
  }
  return merged;
}

function clonePresenceState(state: PresenceStateMap): PresenceStateMap {
  const next: PresenceStateMap = {};
  for (const [key, metas] of Object.entries(state)) {
    next[key] = metas.map((meta) => ({ ...meta }));
  }
  return next;
}
