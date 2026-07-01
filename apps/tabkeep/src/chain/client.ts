import {
  type NizhalCollection,
  type NizhalSQLitePersistence,
  createNizhalBlobs,
  createNizhalClient,
  createNizhalMutators,
  memoryBlobStore,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { chainMutators } from "./mutators.js";
import type { ChainRole, ProductRow, ReceiptRow, SaleRow } from "./schema.js";

export interface ChainClientOptions {
  userId: string;
  /** The branch this device acts in (ctx.ownerId for writes). */
  branchId: string;
  role: ChainRole;
  /** Branch buckets this user may sync — cashier: [own]; owner: [all branches]. */
  branches: string[];
  server?: string;
  token?: string;
  persistence?: NizhalSQLitePersistence;
  subscribeSource?: Parameters<typeof createNizhalClient>[0]["subscribeSource"];
}

export async function createChainClient(options: ChainClientOptions) {
  const echo = createNizhalClient({
    server: options.server,
    auth: options.token ? { headers: { authorization: `Bearer ${options.token}` } } : undefined,
    subscribeSource: options.subscribeSource,
    bucketsForSyncRule: (rule) => (rule === "branch" ? options.branches : []),
  });
  const persistence = options.persistence?.persistence;

  const products = createCollection(
    nizhalCollectionOptions<ProductRow>({
      name: "products",
      syncRule: "branch",
      echo,
      bucketField: "branch_id",
      getKey: (row) => row.id,
      persistence,
    }),
  ) as NizhalCollection<ProductRow>;

  const sales = createCollection(
    nizhalCollectionOptions<SaleRow>({
      name: "sales",
      syncRule: "branch",
      echo,
      bucketField: "branch_id",
      getKey: (row) => row.id,
      persistence,
    }),
  ) as NizhalCollection<SaleRow>;

  const receipts = createCollection(
    nizhalCollectionOptions<ReceiptRow>({
      name: "receipts",
      syncRule: "branch",
      echo,
      bucketField: "branch_id",
      getKey: (row) => row.id,
      persistence,
    }),
  ) as NizhalCollection<ReceiptRow>;

  await Promise.all([products.preload(), sales.preload(), receipts.preload()]);

  const mutators = createNizhalMutators({
    collections: { products, sales, receipts } as Record<string, NizhalCollection<object>>,
    echo,
    actor: { userId: options.userId, ownerId: options.branchId, role: options.role },
    mutators: chainMutators,
    outboxStorage: options.persistence?.outboxStorage,
    mutationIdStorage: options.persistence?.metaStorage,
    deadLetterStorage: options.persistence?.deadLetterStorage,
    clientID: options.persistence?.clientId,
  });
  await mutators.executor.waitForInit();

  const blobs =
    options.server !== undefined
      ? createNizhalBlobs({
          server: options.server,
          auth: options.token
            ? { headers: { authorization: `Bearer ${options.token}` } }
            : undefined,
          store: memoryBlobStore(),
        })
      : undefined;

  return {
    products,
    sales,
    receipts,
    echo,
    blobs,
    mutate: mutators.mutate,
    waitForIdle: mutators.waitForIdle,
    dispose: mutators.dispose,
    // Upload receipt bytes (presigned PUT) then sync the branch-scoped ref row.
    async uploadReceipt(input: { saleId: string; file: Blob }): Promise<{ key: string }> {
      if (!blobs) throw new Error("uploadReceipt requires a server");
      const result = await blobs.upload({
        file: input.file,
        clientMutationId: crypto.randomUUID(),
        pushReference: async ({ key, status }) => {
          await mutators.mutate.attachReceipt({
            id: key,
            saleId: input.saleId,
            mime: input.file.type || "application/octet-stream",
            size: input.file.size,
            status,
          });
        },
      });
      return { key: result.key };
    },
    // Resolve a presigned download URL for a receipt (server enforces branch-scoped authz).
    async receiptUrl(key: string): Promise<string> {
      if (!blobs) throw new Error("receiptUrl requires a server");
      return (await blobs.urlFor({ key })).url;
    },
  };
}

export type ChainClient = Awaited<ReturnType<typeof createChainClient>>;

/** Σ sale amounts for a branch (or all loaded sales when branchId is omitted) — the HQ rollup. */
export function foldBranchSales(entries: readonly SaleRow[], branchId?: string): number {
  return entries.reduce((sum, s) => {
    if (s.deleted_at != null) return sum;
    if (branchId && s.branch_id !== branchId) return sum;
    return sum + s.amount;
  }, 0);
}
