import type { DurableObjectState } from "@cloudflare/workers-types";

export const NIZHAL_PING = "ping";
export const NIZHAL_PONG = "pong";
export const NIZHAL_BUCKET_OPTIONS = { hibernate: true } as const;

export interface NizhalSocketIdentity {
  userId: string;
  ownerId: string;
}

export interface NizhalSocketAttachment {
  version: 1;
  authorization: string;
  bucket: string;
  subscriptions: string[];
  cursor: string | null;
  identity: NizhalSocketIdentity;
  tokenExpiresAt: number | null;
  ephemeralRate: {
    windowStartedAt: number;
    count: number;
  };
}

export interface SocketAttachmentReader {
  deserializeAttachment(): unknown;
}

export interface WebSocketAutoResponseState {
  setWebSocketAutoResponse(pair: AutoResponsePair): void;
}

type AutoResponsePair = NonNullable<Parameters<DurableObjectState["setWebSocketAutoResponse"]>[0]>;

export function createSocketAttachment(input: {
  authorization: string;
  bucket: string;
  cursor: string | null;
  identity: NizhalSocketIdentity;
  tokenExpiresAt: number | null;
}): NizhalSocketAttachment {
  return {
    version: 1,
    authorization: input.authorization,
    bucket: input.bucket,
    subscriptions: [input.bucket],
    cursor: input.cursor,
    identity: input.identity,
    tokenExpiresAt: input.tokenExpiresAt,
    ephemeralRate: { windowStartedAt: 0, count: 0 },
  };
}

export function restoreSocketAttachment(
  socket: SocketAttachmentReader,
): NizhalSocketAttachment | null {
  const value = socket.deserializeAttachment();
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.authorization !== "string" ||
    typeof value.bucket !== "string" ||
    !Array.isArray(value.subscriptions) ||
    !value.subscriptions.every((subscription) => typeof subscription === "string") ||
    !value.subscriptions.includes(value.bucket) ||
    (value.cursor !== null && typeof value.cursor !== "string") ||
    (value.tokenExpiresAt !== null &&
      (typeof value.tokenExpiresAt !== "number" || !Number.isFinite(value.tokenExpiresAt))) ||
    !isIdentity(value.identity) ||
    !isEphemeralRate(value.ephemeralRate)
  ) {
    return null;
  }
  return value as unknown as NizhalSocketAttachment;
}

export function socketCredentialExpired(
  attachment: NizhalSocketAttachment,
  now = Date.now(),
): boolean {
  return attachment.tokenExpiresAt !== null && now >= attachment.tokenExpiresAt;
}

export function configureWebSocketAutoResponse(
  state: WebSocketAutoResponseState,
  createPair: (request: string, response: string) => AutoResponsePair = (request, response) => {
    const Pair = (
      globalThis as unknown as {
        WebSocketRequestResponsePair: new (request: string, response: string) => AutoResponsePair;
      }
    ).WebSocketRequestResponsePair;
    return new Pair(request, response);
  },
): void {
  state.setWebSocketAutoResponse(createPair(NIZHAL_PING, NIZHAL_PONG));
}

function isIdentity(value: unknown): value is NizhalSocketIdentity {
  return isRecord(value) && typeof value.userId === "string" && typeof value.ownerId === "string";
}

function isEphemeralRate(value: unknown): value is NizhalSocketAttachment["ephemeralRate"] {
  return (
    isRecord(value) && typeof value.windowStartedAt === "number" && typeof value.count === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
