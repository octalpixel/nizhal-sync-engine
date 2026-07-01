import { type Actor, defineMutator, defineMutators } from "@nizhal/kernel";
import type { MutatorRegistry } from "@nizhal/kernel";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assets, stockMovements } from "./schema.js";

const saleItem = z.object({
  assetId: z.string(),
  qty: z.number().positive(),
  movementClientId: z.string(),
});

export const ringSaleInput = z.object({
  clientId: z.string(),
  items: z.array(saleItem).min(1),
});

export const receiveStockInput = z.object({
  clientId: z.string(),
  assetId: z.string(),
  qty: z.number().positive(),
});

export const updateProductFieldInput = z.object({
  assetId: z.string(),
  value: z.string().min(1),
});

function requireLocationId(actor: Actor): string {
  const locationId = actor.locationId;
  if (typeof locationId !== "string" || locationId.length === 0) {
    throw new Error("missing locationId on authenticated actor");
  }
  return locationId;
}

function requireAffectedAsset(result: unknown): void {
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error("asset not found in the actor's location");
  }
}

function ringSaleHandler(poisoned: Set<string>) {
  return defineMutator(ringSaleInput, async ({ tx, actor, location }, args) => {
    const locationId = requireLocationId(actor);
    const saleId = args.clientId;
    const at = new Date();

    if (location === "server" && poisoned.has("ringSale")) {
      throw new Error("deterministic poison failure: ringSale");
    }

    for (const item of args.items) {
      await tx.insert(stockMovements).values({
        id: item.movementClientId,
        location_id: locationId,
        asset_id: item.assetId,
        qty: String(-item.qty),
        reason: "sale",
        ref: saleId,
        at,
        client_id: item.movementClientId,
      });
    }

    return { serverId: saleId, affectedBuckets: [locationId] };
  });
}

export function createPosMutators(poisoned = new Set<string>()): MutatorRegistry {
  return defineMutators({
    ringSale: ringSaleHandler(poisoned),
    receiveStock: defineMutator(receiveStockInput, async ({ tx, actor }, args) => {
      const locationId = requireLocationId(actor);
      await tx.insert(stockMovements).values({
        id: args.clientId,
        location_id: locationId,
        asset_id: args.assetId,
        qty: String(args.qty),
        reason: "receive",
        ref: null,
        at: new Date(),
        client_id: args.clientId,
      });
      return { serverId: args.clientId, affectedBuckets: [locationId] };
    }),
    updateProductName: defineMutator(
      updateProductFieldInput,
      async ({ tx, actor, location }, args) => {
        const locationId = requireLocationId(actor);
        if (location === "server" && poisoned.has("updateProductName")) {
          throw new Error("deterministic poison failure: updateProductName");
        }
        const rows = await tx
          .update(assets, { id: args.assetId, location_id: locationId })
          .set({ name: args.value });
        if (location === "server") requireAffectedAsset(rows);
        return { affectedBuckets: [locationId] };
      },
    ),
    updateProductSku: defineMutator(
      updateProductFieldInput,
      async ({ tx, actor, location }, args) => {
        const locationId = requireLocationId(actor);
        if (location === "server" && poisoned.has("updateProductSku")) {
          throw new Error("deterministic poison failure: updateProductSku");
        }
        const rows = await tx
          .update(assets, { id: args.assetId, location_id: locationId })
          .set({ sku: args.value });
        if (location === "server") requireAffectedAsset(rows);
        return { affectedBuckets: [locationId] };
      },
    ),
    seedAsset: defineMutator(
      z.object({
        clientId: z.string(),
        name: z.string(),
        sku: z.string().optional(),
        price: z.number().nonnegative().default(0),
      }),
      async ({ tx, actor, newId }, args) => {
        const locationId = requireLocationId(actor);
        const id = args.clientId || newId();
        await tx.insert(assets).values({
          id,
          location_id: locationId,
          name: args.name,
          sku: args.sku ?? null,
          price: String(args.price),
          client_id: args.clientId,
        });
        return { serverId: id, affectedBuckets: [locationId] };
      },
    ),
  }) as MutatorRegistry;
}

export const posMutators = createPosMutators();

export async function serverStockOnHand(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { on_hand: string }[] }> },
  locationId: string,
  assetId: string,
): Promise<number> {
  const result = await db.query(
    `select coalesce(sum(qty::numeric), 0)::text as on_hand
     from stock_movements
     where location_id = $1 and asset_id = $2 and deleted_at is null`,
    [locationId, assetId],
  );
  return Number(result.rows[0]?.on_hand ?? 0);
}

export async function serverVarianceCount(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  locationId: string,
): Promise<number> {
  const result = await db.query(
    "select count(*)::int as count from stock_variances where location_id = $1",
    [locationId],
  );
  return Number((result.rows[0] as { count?: number })?.count ?? 0);
}

export async function serverMovementCount(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  locationId: string,
): Promise<number> {
  const result = await db.query(
    "select count(*)::int as count from stock_movements where location_id = $1",
    [locationId],
  );
  return Number((result.rows[0] as { count?: number })?.count ?? 0);
}

export async function serverMutationCount(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  clientMutationId: string,
): Promise<number> {
  const result = await db.query(
    "select count(*)::int as count from _nizhal_mutations where client_mutation_id = $1",
    [clientMutationId],
  );
  return Number((result.rows[0] as { count?: number })?.count ?? 0);
}
