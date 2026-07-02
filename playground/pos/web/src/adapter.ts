import { NizhalSyncTargetError } from "@nizhal/db-collection";
import type {
  NizhalPullRequest,
  NizhalPullResponse,
  NizhalPushRequest,
  NizhalSyncTarget,
} from "@nizhal/db-collection";
import type { Mutation } from "@nizhal/kernel";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ★ The whole point of the B2 tier, in one file: a custom NizhalSyncTarget over the EXISTING
// REST API. The Nizhal client (store, outbox, replay-rebase, live queries) is completely
// unchanged — it only ever talks to this interface.
//
//   pull → GET  /sync/changes?since=<cursor>   (the backend's change feed)
//   push → the backend's OWN endpoints          (recordSale → POST /orders, idempotency-key'd)
//
// Honest ceiling (documented in rfc-local-sync-convergence §7 B2): correctness is bounded by
// the backend's change tracking — a seq counter + tombstones here, not xid8 commit ordering.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export function restSyncTarget(server: string): NizhalSyncTarget {
  return {
    async pull(request: NizhalPullRequest): Promise<NizhalPullResponse> {
      const since = request.cursor === "" || request.cursor === "0" ? 0 : Number(request.cursor);
      const response = await fetch(`${server}/sync/changes?since=${since}`);
      if (!response.ok) {
        throw new NizhalSyncTargetError(`pull failed: ${response.status}`, { retriable: true });
      }
      const body = (await response.json()) as {
        products: Record<string, unknown>[];
        orders: Record<string, unknown>[];
        deleted: { tbl: string; id: string }[];
        seq: number;
      };
      return {
        changed: [
          { table: "products", rows: body.products },
          { table: "orders", rows: body.orders },
        ],
        tombstoned: body.deleted.map((entry) => ({ table: entry.tbl, id: entry.id })),
        removed: [],
        removedBuckets: [],
        cursor: String(body.seq),
        hasMore: false,
      };
    },

    async push(mutation: NizhalPushRequest) {
      const response = await routeMutation(server, mutation);
      if (response.status === 422) {
        // the backend's business rules said no — terminal, park it (never blind-retry)
        throw new NizhalSyncTargetError(await response.text(), { retriable: false });
      }
      if (!response.ok) {
        throw new NizhalSyncTargetError(`push failed: ${response.status}`, { retriable: true });
      }
      const body = (await response.json()) as { duplicate?: boolean };
      return {
        status: body.duplicate ? ("duplicate" as const) : ("applied" as const),
        // no Nizhal server = no per-client sequence check; echo the id so the engine's
        // high-water advances
        lastMutationId: mutation.mutationID,
      };
    },
  };
}

// Named mutations → the endpoints the backend already had. Adding a mutator = adding a case.
async function routeMutation(server: string, mutation: Mutation): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // idempotency: a retried push must not double-apply (the backend dedupes on this)
    ...(mutation.clientMutationId ? { "idempotency-key": mutation.clientMutationId } : {}),
  };
  switch (mutation.name) {
    case "recordSale": {
      const args = mutation.args as {
        id: string;
        productId: string;
        quantity: number;
        priceCents: number;
      };
      return fetch(`${server}/orders`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: args.id,
          productId: args.productId,
          quantity: args.quantity,
          totalCents: args.quantity * args.priceCents,
        }),
      });
    }
    default:
      return new Response(`no route for mutation '${mutation.name}'`, { status: 422 });
  }
}
