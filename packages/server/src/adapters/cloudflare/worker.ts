import type { DurableObjectNamespace, ExecutionContext } from "@cloudflare/workers-types";
import { routePartykitRequest } from "partyserver";
import type { NizhalAuthorizationEnv } from "./authorization.js";
import { NizhalBucket } from "./server.js";

export { NizhalBucket };

export interface NizhalWorkerEnv extends NizhalAuthorizationEnv {
  NizhalBucket: DurableObjectNamespace;
}

export interface NizhalWorkerFetchOptions {
  app: {
    fetch(
      request: Request,
      env: NizhalWorkerEnv,
      ctx: ExecutionContext,
    ): Response | Promise<Response>;
  };
  verifyToken(
    token: string | null,
    env: NizhalWorkerEnv,
  ): Promise<{
    userId: string;
    ownerId: string;
    displayName?: string;
    tokenExpiresAt?: number;
  } | null>;
  actorMaySeeBucket(
    actor: { userId: string; ownerId: string },
    bucket: string,
  ): boolean | Promise<boolean>;
}

/**
 * Builds a Cloudflare Worker `fetch` handler that routes realtime WS connections to the
 * NizhalBucket DO and everything else to the provided Hono app. Auth is enforced in
 * `onBeforeConnect` using the same `?token=` query param as the Node `/sync/stream` path.
 */
export function createNizhalWorkerFetchHandler(
  options: NizhalWorkerFetchOptions,
): (request: Request, env: NizhalWorkerEnv, ctx: ExecutionContext) => Promise<Response> {
  return async function fetch(request, env, ctx) {
    const partyResponse = await routePartykitRequest(request, env, {
      onBeforeConnect: async (req, { name }) => {
        const token = new URL(req.url).searchParams.get("token");
        const actor = await options.verifyToken(token, env);
        if (!actor || !(await options.actorMaySeeBucket(actor, name))) {
          return new Response("forbidden", { status: 403 });
        }
        return new Request(req, {
          headers: {
            ...Object.fromEntries(req.headers.entries()),
            "x-nizhal-authorization": `Bearer ${token}`,
            "x-nizhal-user-id": actor.userId,
            "x-nizhal-owner-id": actor.ownerId,
            ...(actor.displayName ? { "x-nizhal-display-name": actor.displayName } : {}),
            ...(actor.tokenExpiresAt !== undefined
              ? { "x-nizhal-token-expires-at": String(actor.tokenExpiresAt) }
              : {}),
          },
        });
      },
    });
    if (partyResponse) return partyResponse;
    return options.app.fetch(request, env, ctx);
  };
}
