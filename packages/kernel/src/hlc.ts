export interface HlcTimestamp {
  wallTime: number;
  counter: number;
  nodeId: string;
}

export interface HlcClockOptions {
  nodeId: string;
  now?: () => number;
  maxDriftMs?: number;
}

export interface HlcClock {
  send(): string;
  recv(remote: string): string;
  readonly nodeId: string;
}

const COUNTER_WIDTH = 4;
// Full 128-bit (UUID) node id in hex. Truncating to 64 bits aliased distinct devices and made the
// field-merge HLC tiebreak pick the wrong winner on a collision (a silently-lost edit).
const NODE_ID_WIDTH = 32;
const DEFAULT_MAX_DRIFT_MS = 60_000;

export function createHlcClock(options: HlcClockOptions): HlcClock {
  let wallTime = 0;
  let counter = 0;
  const now = options.now ?? Date.now;
  const nodeId = normalizeHlcNodeId(options.nodeId);
  const maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;

  return {
    nodeId,
    send() {
      const physical = now();
      const nextWall = Math.max(wallTime, physical);
      counter = nextWall === wallTime ? counter + 1 : 0;
      wallTime = nextWall;
      assertHlcBounds(wallTime, counter, physical, maxDriftMs);
      return formatHlc({ wallTime, counter, nodeId });
    },
    recv(remote) {
      const message = parseHlc(remote);
      const physical = now();
      const previousWall = wallTime;
      const nextWall = Math.max(previousWall, message.wallTime, physical);
      if (nextWall === previousWall && nextWall === message.wallTime) {
        counter = Math.max(counter, message.counter) + 1;
      } else if (nextWall === previousWall) {
        counter += 1;
      } else if (nextWall === message.wallTime) {
        counter = message.counter + 1;
      } else {
        counter = 0;
      }
      wallTime = nextWall;
      assertHlcBounds(wallTime, counter, physical, maxDriftMs);
      return formatHlc({ wallTime, counter, nodeId });
    },
  };
}

export function formatHlc(timestamp: HlcTimestamp): string {
  return `${new Date(timestamp.wallTime).toISOString()}-${timestamp.counter
    .toString(16)
    .padStart(COUNTER_WIDTH, "0")}-${normalizeHlcNodeId(timestamp.nodeId)}`;
}

export function parseHlc(value: string): HlcTimestamp {
  const match = new RegExp(`^(.{24})-([0-9a-fA-F]{4})-([0-9a-fA-F]{${NODE_ID_WIDTH}})$`).exec(
    value,
  );
  if (!match) throw new Error(`Invalid HLC timestamp '${value}'`);
  const wallTime = Date.parse(match[1] ?? "");
  if (Number.isNaN(wallTime)) throw new Error(`Invalid HLC wall time '${value}'`);
  return {
    wallTime,
    counter: Number.parseInt(match[2] ?? "0", 16),
    nodeId: normalizeHlcNodeId(match[3] ?? ""),
  };
}

export function compareHlc(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function normalizeHlcNodeId(value: string): string {
  const hex = value.replaceAll(/[^0-9a-fA-F]/g, "").toLowerCase();
  return hex.padStart(NODE_ID_WIDTH, "0").slice(-NODE_ID_WIDTH);
}

function assertHlcBounds(
  wallTime: number,
  counter: number,
  physical: number,
  maxDriftMs: number,
): void {
  if (wallTime - physical > maxDriftMs) {
    throw new Error(`HLC clock drift exceeds ${maxDriftMs}ms`);
  }
  if (counter > 0xffff) throw new Error("HLC counter overflow");
}
