import {
  type NizhalCollection,
  createNizhalClient,
  createNizhalMutators,
  nizhalCollectionOptions,
  waSqlitePersistence,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { posMutators } from "./mutators";
import type { ProductRow, SaleItemRow, SaleRow } from "./schema";
import { openWaSqlite } from "./wa";

const OWNER = "shop-1"; // single offline shop for now (becomes the sync bucket later)

export interface PosStore {
  products: NizhalCollection<ProductRow>;
  sales: NizhalCollection<SaleRow>;
  saleItems: NizhalCollection<SaleItemRow>;
  mutate: Record<string, (args: any) => unknown>;
  ownerId: string;
}

export async function createPosStore(): Promise<PosStore> {
  const db = await openWaSqlite("pos-nizhal.db");
  const store = await waSqlitePersistence({ database: db });
  const echo = createNizhalClient({});

  const products = createCollection(
    nizhalCollectionOptions<ProductRow>({
      name: "products",
      syncRule: "myShop",
      echo,
      bucketField: "owner_id",
      getKey: (r) => r.id,
      persistence: store.persistence,
    }),
  ) as NizhalCollection<ProductRow>;
  const sales = createCollection(
    nizhalCollectionOptions<SaleRow>({
      name: "sales",
      syncRule: "myShop",
      echo,
      bucketField: "owner_id",
      getKey: (r) => r.id,
      persistence: store.persistence,
    }),
  ) as NizhalCollection<SaleRow>;
  const saleItems = createCollection(
    nizhalCollectionOptions<SaleItemRow>({
      name: "sale_items",
      syncRule: "myShop",
      echo,
      bucketField: "owner_id",
      getKey: (r) => r.id,
      persistence: store.persistence,
    }),
  ) as NizhalCollection<SaleItemRow>;

  await Promise.all([products.preload(), sales.preload(), saleItems.preload()]);

  const { mutate, executor } = createNizhalMutators({
    collections: {
      products,
      sales,
      sale_items: saleItems,
    } as Record<string, NizhalCollection<object>>,
    echo,
    actor: { userId: "user-1", ownerId: OWNER },
    mutators: posMutators,
    outboxStorage: store.outboxStorage,
    mutationIdStorage: store.metaStorage,
    deadLetterStorage: store.deadLetterStorage,
    clientID: store.clientId,
  });
  await executor.waitForInit();

  return { products, sales, saleItems, mutate, ownerId: OWNER };
}
