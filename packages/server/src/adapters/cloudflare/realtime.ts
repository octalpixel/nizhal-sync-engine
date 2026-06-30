import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { BucketKey } from "@nizhal/kernel";
import type { RealtimeAdapter } from "../realtime.js";

export interface CloudflareRealtimeEnv {
  NizhalBucket: DurableObjectNamespace;
}

export interface CloudflareRealtimeOptions {
  getServerByName?: (
    namespace: DurableObjectNamespace,
    name: string,
  ) => Promise<{ repull(bucket: string): Promise<void> }>;
}

/**
 * Cloudflare-only realtime adapter. Each bucket is a PartyServer room (one DO instance).
 * `publish` does an RPC into the bucket DO, which broadcasts `repull:${bucket}` to its
 * connected clients. Subscribe is a no-op locally because fan-out lives in the DO.
 */
export function cloudflareRealtime(
  env: CloudflareRealtimeEnv,
  options?: CloudflareRealtimeOptions,
): RealtimeAdapter {
  return {
    async publish(bucket: BucketKey) {
      const resolveGetServerByName =
        options?.getServerByName ??
        (async (namespace, name) => {
          const { getServerByName } = await import("partyserver");
          const stub = await getServerByName(namespace, name);
          return stub as unknown as { repull(bucket: string): Promise<void> };
        });
      const stub = await resolveGetServerByName(env.NizhalBucket, bucket);
      await stub.repull(bucket);
    },
    subscribe() {
      return () => {};
    },
  };
}

export interface CloudflareHttpRealtimeOptions {
  /** The deployed worker's publish endpoint, e.g. `https://nizhal-realtime.acme.workers.dev/_nizhal/publish`. */
  publishUrl: string;
  /** Shared secret matching the worker's `NIZHAL_PUBLISH_SECRET`. */
  publishSecret: string;
  /** Override fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Realtime adapter for a **Node** Nizhal server fronting a Cloudflare realtime worker. Unlike
 * {@link cloudflareRealtime} (which RPCs the DO directly and only works when the server itself runs
 * on Workers), this drives the DO over HTTP via the worker's `POST /_nizhal/publish` bridge — so a
 * self-hosted Node server can fan out through Cloudflare. Subscribe is a no-op; fan-out is the DO's.
 */
export function cloudflareHttpRealtime(options: CloudflareHttpRealtimeOptions): RealtimeAdapter {
  const doFetch = options.fetch ?? fetch;
  return {
    async publish(bucket: BucketKey) {
      const url = `${options.publishUrl}?bucket=${encodeURIComponent(bucket)}`;
      const res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.publishSecret}` },
      });
      if (!res.ok) {
        throw new Error(`cloudflare publish failed: ${res.status}`);
      }
    },
    subscribe() {
      return () => {};
    },
  };
}
