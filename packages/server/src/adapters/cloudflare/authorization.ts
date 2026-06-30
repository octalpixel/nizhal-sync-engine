export interface NizhalAuthorizationFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface NizhalAuthorizationEnv {
  NIZHAL_AUTHORIZATION_SERVICE?: NizhalAuthorizationFetcher;
  NIZHAL_AUTHORIZATION_URL?: string;
}

export interface AuthorizedConnection {
  deserializeAttachment(): unknown;
  send(message: string): void;
  close(code: number, reason: string): void;
}

export interface RealtimeIdentity {
  userId: string;
  ownerId?: string;
  tokenExpiresAt?: number;
}

export async function authorizeRealtimeRoom(
  token: string | null,
  bucket: string,
  env: NizhalAuthorizationEnv,
  verifyToken: (token: string | null) => Promise<RealtimeIdentity | null>,
): Promise<{ authorization: string; identity: RealtimeIdentity } | Response> {
  const identity = await verifyToken(token);
  if (!identity) return new Response("unauthorized", { status: 401 });
  // Misconfiguration must be loud and distinct from a real access denial: without an authorization
  // backend the worker can't authorize any bucket, which would otherwise surface as a blanket 403
  // ("looks like a token problem") while realtime is simply unconfigured. Fail with an actionable 500.
  if (!env.NIZHAL_AUTHORIZATION_SERVICE && !env.NIZHAL_AUTHORIZATION_URL) {
    return new Response(
      "nizhal realtime authorization is not configured: set NIZHAL_AUTHORIZATION_URL (or bind NIZHAL_AUTHORIZATION_SERVICE) to your Nizhal server so the worker can authorize bucket subscriptions",
      { status: 500 },
    );
  }
  const authorization = `Bearer ${token}`;
  if (!(await authorizeBucket(env, authorization, bucket))) {
    return new Response("forbidden", { status: 403 });
  }
  return { authorization, identity };
}

export async function authorizeBucket(
  env: NizhalAuthorizationEnv,
  authorization: string,
  bucket: string,
): Promise<boolean> {
  return (await bucketAuthorizationStatus(env, authorization, bucket)) === 204;
}

async function bucketAuthorizationStatus(
  env: NizhalAuthorizationEnv,
  authorization: string,
  bucket: string,
): Promise<number> {
  const url = new URL(
    "/sync/realtime/authorize",
    env.NIZHAL_AUTHORIZATION_URL ?? "https://nizhal.internal",
  );
  url.searchParams.set("bucket", bucket);
  const request = new Request(url, { headers: { authorization } });
  const response = env.NIZHAL_AUTHORIZATION_SERVICE
    ? await env.NIZHAL_AUTHORIZATION_SERVICE.fetch(request)
    : env.NIZHAL_AUTHORIZATION_URL
      ? await fetch(request)
      : null;
  return response?.status ?? 503;
}

export async function repullAuthorizedConnections(
  connections: Iterable<AuthorizedConnection>,
  env: NizhalAuthorizationEnv,
  bucket: string,
  now = Date.now(),
): Promise<void> {
  for (const connection of await authorizedConnections(connections, env, bucket, now)) {
    connection.send(`repull:${bucket}`);
  }
}

export async function authorizedConnections<T extends AuthorizedConnection>(
  connections: Iterable<T>,
  env: NizhalAuthorizationEnv,
  bucket: string,
  now = Date.now(),
): Promise<T[]> {
  const authorized: T[] = [];
  for (const connection of connections) {
    const attachment = restoreSocketAttachment(connection);
    if (!attachment) {
      connection.close(1008, "connection state missing");
      continue;
    }
    if (socketCredentialExpired(attachment, now)) {
      connection.close(1008, "credential expired");
      continue;
    }
    const status = await bucketAuthorizationStatus(env, attachment.authorization, bucket);
    if (status === 401) {
      connection.close(1008, "credential expired");
      continue;
    }
    if (status !== 204) {
      connection.close(1008, "bucket access revoked");
      continue;
    }
    authorized.push(connection);
  }
  return authorized;
}

import { restoreSocketAttachment, socketCredentialExpired } from "./socket-state.js";
