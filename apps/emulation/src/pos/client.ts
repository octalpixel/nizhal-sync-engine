import type { NizhalClient } from "@nizhal/db-collection";
import { nizhalCollectionOptions } from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import type { AssetRow, StockMovementRow, StockVarianceRow } from "./schema.js";

export const POS_LOCATION_ID = "loc-1";
export const POS_OWNER_ID = "owner-1";
export const POS_ASSET_ID = "asset-1";

export function buildPosCollections(input: {
  echo: NizhalClient;
  persistence?: Parameters<typeof nizhalCollectionOptions>[0]["persistence"];
}) {
  const assets = createCollection(
    nizhalCollectionOptions<AssetRow>({
      name: "assets",
      syncRule: "myTerminal",
      echo: input.echo,
      bucketField: "location_id",
      getKey: (row) => row.client_id ?? row.id,
      persistence: input.persistence,
    }),
  );

  const stock_movements = createCollection(
    nizhalCollectionOptions<StockMovementRow>({
      name: "stock_movements",
      syncRule: "myTerminal",
      echo: input.echo,
      bucketField: "location_id",
      getKey: (row) => row.client_id ?? row.id,
      persistence: input.persistence,
    }),
  );

  const stock_variances = createCollection(
    nizhalCollectionOptions<StockVarianceRow>({
      name: "stock_variances",
      syncRule: "myTerminal",
      echo: input.echo,
      bucketField: "location_id",
      getKey: (row) => row.client_id ?? row.id,
      persistence: input.persistence,
    }),
  );

  return { assets, stock_movements, stock_variances };
}
