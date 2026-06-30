// Per-client mutation sequence. The server (checkMutationSequence) requires `mutationID == last + 1`
// per clientID, monotonic across sessions. The clientID is persisted, so the counter MUST be too —
// a counter that reset to 1 each app launch would re-emit already-applied IDs (`<= last`), which the
// server treats as "alreadyApplied" and the client clears from the outbox, silently losing the write.
// We persist the high-water under a non-`tx:` key the outbox manager ignores.

export const MUTATION_ID_KEY = "nizhal:mutation-id";
const ALLOCATED_MUTATION_ID_PREFIX = `${MUTATION_ID_KEY}:allocated:`;

export interface MutationIdStorage {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** A mutationID is a positive safe integer; anything else (corrupt persisted value, fractional,
 *  beyond 2^53) is not a usable sequence position. */
function asValidMutationId(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Next mutationID to assign: one past the highest of the persisted high-water and any IDs still
 * pending in the durable outbox (the latter covers the window where a queued mutation's id was
 * durable but its high-water write hadn't flushed yet). Inputs are validated to positive safe
 * integers so a corrupt value cannot produce a fractional/unsafe id the server would reject.
 */
export function nextMutationIdFrom(persisted: number, pendingIds: readonly number[]): number {
  const base = pendingIds.reduce(
    (max, id) => Math.max(max, asValidMutationId(id)),
    asValidMutationId(persisted),
  );
  const next = base + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("[@nizhal/db-collection] mutation sequence exhausted (exceeds 2^53)");
  }
  return next;
}

export function allocateMutationId(
  serverHighWater: number,
  localHighWater: number,
  pendingIds: readonly number[] = [],
): number {
  return nextMutationIdFrom(
    Math.max(asValidMutationId(serverHighWater), asValidMutationId(localHighWater)),
    pendingIds,
  );
}

export async function readPersistedMutationId(storage: MutationIdStorage): Promise<number> {
  const raw = await storage.get(MUTATION_ID_KEY);
  return raw == null ? 0 : asValidMutationId(Number(raw));
}

export async function writePersistedMutationId(
  storage: MutationIdStorage,
  mutationId: number,
): Promise<void> {
  await storage.set(MUTATION_ID_KEY, String(mutationId));
}

export async function readAllocatedMutationId(
  storage: MutationIdStorage,
  idempotencyKey: string,
): Promise<number> {
  const raw = await storage.get(allocatedMutationIdKey(idempotencyKey));
  return raw == null ? 0 : asValidMutationId(Number(raw));
}

export async function writeAllocatedMutationId(
  storage: MutationIdStorage,
  idempotencyKey: string,
  mutationId: number,
): Promise<void> {
  await storage.set(allocatedMutationIdKey(idempotencyKey), String(mutationId));
}

function allocatedMutationIdKey(idempotencyKey: string): string {
  return `${ALLOCATED_MUTATION_ID_PREFIX}${idempotencyKey}`;
}
