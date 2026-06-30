import { createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "@nizhal/kernel";
import type { NizhalAuth } from "./index.js";

export interface IssueBearerTokenInput {
  secret: string;
  userId: string;
  ownerId: string;
  expiresInSec?: number;
  displayName?: string;
}

export interface BearerTokenAuthOptions {
  verify?: (token: string) => Promise<Actor | null> | Actor | null;
  secret?: string;
}

/** Issue an HS256 bearer token for tests and token-rotation flows. */
export function issueBearerToken(input: IssueBearerTokenInput): string {
  const exp = Math.floor(Date.now() / 1000) + (input.expiresInSec ?? 3600);
  const payload: Record<string, unknown> = {
    userId: input.userId,
    ownerId: input.ownerId,
    exp,
  };
  if (input.displayName !== undefined) payload.displayName = input.displayName;
  return signHs256Jwt(payload, input.secret);
}

export function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = hmacBase64Url(`${encodedHeader}.${encodedPayload}`, secret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function bearerTokenAuth(options: BearerTokenAuthOptions): NizhalAuth {
  if (!options.verify && !options.secret) {
    throw new Error("[@nizhal/server] bearerTokenAuth requires verify or secret");
  }
  return {
    async resolve(req) {
      const token = bearerToken(req.headers.get("authorization"));
      if (!token) return null;
      const actor = options.verify
        ? await options.verify(token)
        : verifyHs256Jwt(token, options.secret ?? "");
      return actor && typeof actor.userId === "string" && typeof actor.ownerId === "string"
        ? actor
        : null;
    },
  };
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function verifyHs256Jwt(token: string, secret: string): Actor | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJson(encodedHeader);
  if (!isRecord(header) || header.alg !== "HS256") return null;
  const expected = hmacBase64Url(`${encodedHeader}.${encodedPayload}`, secret);
  if (!constantTimeEqual(encodedSignature, expected)) return null;

  const payload = decodeJson(encodedPayload);
  if (!isRecord(payload)) return null;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  if (Date.now() >= payload.exp * 1000) return null;
  if (typeof payload.userId !== "string" || typeof payload.ownerId !== "string") return null;
  return payload as Actor;
}

function decodeJson(input: string): unknown {
  try {
    return JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function hmacBase64Url(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
