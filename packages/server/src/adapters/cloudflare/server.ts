import type { DurableObjectState } from "@cloudflare/workers-types";
import { type Connection, type ConnectionContext, Server, type WSMessage } from "partyserver";
import {
  type NizhalAuthorizationEnv,
  authorizedConnections,
  repullAuthorizedConnections,
} from "./authorization.js";
import { isEphemeralFrame, relayEphemeralFrame } from "./ephemeral.js";
import {
  NIZHAL_BUCKET_OPTIONS,
  configureWebSocketAutoResponse,
  createSocketAttachment,
} from "./socket-state.js";

export interface NizhalBucketEnv extends NizhalAuthorizationEnv {}

/**
 * One Durable Object instance per Nizhal bucket. Holds the bucket's WebSocket connections and
 * fans out `repull:${bucket}` pings sent from the server commit chokepoint via RPC.
 */
export class NizhalBucket extends Server<NizhalBucketEnv> {
  static options = NIZHAL_BUCKET_OPTIONS;
  private readonly bindings: NizhalBucketEnv;

  constructor(ctx: DurableObjectState, env: NizhalBucketEnv) {
    super(ctx, env);
    this.bindings = env;
    configureWebSocketAutoResponse(ctx);
  }

  onConnect(connection: Connection, context: ConnectionContext) {
    const authorization = context.request.headers.get("x-nizhal-authorization");
    const userId = context.request.headers.get("x-nizhal-user-id");
    const ownerId = context.request.headers.get("x-nizhal-owner-id");
    if (!authorization || !userId || !ownerId) {
      connection.close(1008, "authorization context missing");
      return;
    }
    const expires = context.request.headers.get("x-nizhal-token-expires-at");
    const tokenExpiresAt = expires === null ? null : Number(expires);
    if (tokenExpiresAt !== null && !Number.isFinite(tokenExpiresAt)) {
      connection.close(1008, "authorization context invalid");
      return;
    }
    const cursor = new URL(context.request.url).searchParams.get("cursor");
    connection.serializeAttachment(
      createSocketAttachment({
        authorization,
        bucket: this.name,
        cursor,
        identity: { userId, ownerId },
        tokenExpiresAt,
      }),
    );
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string" || !isEphemeralFrame(message)) return;
    const authorized = await authorizedConnections(this.getConnections(), this.bindings, this.name);
    if (!authorized.includes(connection)) return;
    relayEphemeralFrame(connection, authorized, message);
  }

  async repull(bucket: string) {
    await repullAuthorizedConnections(this.getConnections(), this.bindings, bucket);
  }
}
