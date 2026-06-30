import {
  type NizhalSocketAttachment,
  restoreSocketAttachment,
  socketCredentialExpired,
} from "./socket-state.js";

export const EPHEMERAL_RATE_LIMIT = 30;
const EPHEMERAL_RATE_WINDOW_MS = 1_000;
const EPHEMERAL_PREFIXES = ["presence:", "typing:", "cursor:", "whisper:"] as const;

export interface EphemeralConnection {
  id: string;
  send(message: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(attachment: NizhalSocketAttachment): void;
  deserializeAttachment(): unknown;
}

export function isEphemeralFrame(frame: string): boolean {
  return EPHEMERAL_PREFIXES.some((prefix) => frame.startsWith(prefix));
}

export function relayEphemeralFrame(
  sender: EphemeralConnection,
  connections: Iterable<EphemeralConnection>,
  frame: string,
  now = Date.now(),
): boolean {
  if (!isEphemeralFrame(frame)) return false;
  const attachment = restoreSocketAttachment(sender);
  if (!attachment) {
    sender.close(1008, "connection state missing");
    return false;
  }
  if (socketCredentialExpired(attachment, now)) {
    sender.close(1008, "credential expired");
    return false;
  }
  if (!consumeRateLimit(attachment, now)) {
    sender.close(1008, "ephemeral rate limit exceeded");
    return false;
  }
  sender.serializeAttachment(attachment);

  const isWhisper = frame.startsWith("whisper:");
  const whisperTarget = isWhisper ? whisperTargetUserId(frame) : null;
  if (isWhisper && whisperTarget === null) {
    sender.close(1008, "invalid whisper target");
    return false;
  }
  for (const connection of connections) {
    if (connection.id === sender.id) continue;
    const recipient = restoreSocketAttachment(connection);
    if (!recipient) {
      connection.close(1008, "connection state missing");
      continue;
    }
    if (socketCredentialExpired(recipient, now)) {
      connection.close(1008, "credential expired");
      continue;
    }
    if (whisperTarget !== null && recipient.identity.userId !== whisperTarget) continue;
    connection.send(frame);
  }
  return true;
}

function consumeRateLimit(attachment: NizhalSocketAttachment, now: number): boolean {
  const rate = attachment.ephemeralRate;
  if (rate.windowStartedAt === 0 || now - rate.windowStartedAt >= EPHEMERAL_RATE_WINDOW_MS) {
    rate.windowStartedAt = now;
    rate.count = 1;
    return true;
  }
  if (rate.count >= EPHEMERAL_RATE_LIMIT) return false;
  rate.count += 1;
  return true;
}

function whisperTargetUserId(frame: string): string | null {
  try {
    const value = JSON.parse(frame.slice("whisper:".length)) as unknown;
    return isRecord(value) && typeof value.to === "string" ? value.to : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
