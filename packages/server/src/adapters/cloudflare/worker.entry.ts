import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { getServerByName, routePartykitRequest } from "partyserver";
import { type NizhalAuthorizationFetcher, authorizeRealtimeRoom } from "./authorization.js";
import { NizhalBucket } from "./server.js";

// Re-export the Durable Object class so wrangler can bind it.
export { NizhalBucket };

export interface NizhalRealtimeEnv {
  NizhalBucket: DurableObjectNamespace;
  /** HMAC secret for verifying the `?token=` on WS upgrade (matches bearerTokenAuth HS256). */
  NIZHAL_JWT_SECRET?: string;
  /** Shared secret authorizing the server→DO publish bridge (`POST /_nizhal/publish`). */
  NIZHAL_PUBLISH_SECRET?: string;
  NIZHAL_AUTHORIZATION_SERVICE?: NizhalAuthorizationFetcher;
  NIZHAL_AUTHORIZATION_URL?: string;
}

/**
 * Deployable Cloudflare Worker for Nizhal realtime: WS upgrades route to the per-bucket
 * `NizhalBucket` Durable Object (one DO per bucket = room name). This is the module-worker
 * entry (`export default { fetch }`) wrangler requires to bind a DO — the library factory in
 * `worker.ts` stays for embedding in a larger Worker. Auth uses Web Crypto (Workers has no
 * `node:crypto`), reading the `?token=` query param like the Node `/sync/stream` path.
 *
 * A Node Nizhal server reaches this DO via the `POST /_nizhal/publish` bridge (below): on commit it
 * POSTs `{bucket}` with the `NIZHAL_PUBLISH_SECRET` bearer, and the worker RPCs the bucket DO's
 * `repull`, which broadcasts to connected clients. Pair with `cloudflareHttpRealtime`.
 */
export default {
  async fetch(request: Request, env: NizhalRealtimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/_nizhal/publish") {
      return publishToBucket(request, url, env);
    }
    const handled = await routePartykitRequest(request, env, {
      onBeforeConnect: async (req: Request, { name }) => {
        const token = new URL(req.url).searchParams.get("token");
        const result = await authorizeRealtimeRoom(token, name, env, (value) =>
          verifyHs256(value, env.NIZHAL_JWT_SECRET),
        );
        if (result instanceof Response) return result;
        const headers = new Headers(req.headers);
        headers.set("x-nizhal-authorization", result.authorization);
        headers.set("x-nizhal-user-id", result.identity.userId);
        if (result.identity.ownerId) headers.set("x-nizhal-owner-id", result.identity.ownerId);
        if (result.identity.tokenExpiresAt !== undefined) {
          headers.set("x-nizhal-token-expires-at", String(result.identity.tokenExpiresAt));
        }
        return new Request(req, { headers });
      },
    });
    return handled ?? new Response("Not Found", { status: 404 });
  },
};

/** Server→DO publish bridge: auth with the shared secret, then RPC the bucket DO's `repull`. */
async function publishToBucket(
  request: Request,
  url: URL,
  env: NizhalRealtimeEnv,
): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (!env.NIZHAL_PUBLISH_SECRET || auth !== `Bearer ${env.NIZHAL_PUBLISH_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  const bucket = url.searchParams.get("bucket");
  if (!bucket) return new Response("missing bucket", { status: 400 });
  const stub = (await getServerByName(env.NizhalBucket, bucket)) as unknown as {
    repull(bucket: string): Promise<void>;
  };
  await stub.repull(bucket);
  return new Response(null, { status: 204 });
}

async function verifyHs256(
  token: string | null,
  secret: string | undefined,
): Promise<{ userId: string; ownerId: string; tokenExpiresAt: number } | null> {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  const headerJson = decodeJson(header);
  if (!isRecord(headerJson) || headerJson.alg !== "HS256") return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return null;

  const body = decodeJson(payload);
  if (!isRecord(body)) return null;
  if (typeof body.exp !== "number" || Date.now() >= body.exp * 1000) return null;
  if (typeof body.userId !== "string" || typeof body.ownerId !== "string") return null;
  return { userId: body.userId, ownerId: body.ownerId, tokenExpiresAt: body.exp * 1000 };
}

function decodeJson(input: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input))) as unknown;
  } catch {
    return null;
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
