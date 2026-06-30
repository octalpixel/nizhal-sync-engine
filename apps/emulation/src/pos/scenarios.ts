import type { NizhalAuth } from "@nizhal/server";
import {
  type ChaosClientHandle,
  type ChaosHarness,
  createChaosHarness,
  waitFor,
} from "../harness/chaos-harness.js";
import { POS_ASSET_ID, POS_LOCATION_ID, POS_OWNER_ID, buildPosCollections } from "./client.js";
import {
  createPosMutators,
  serverMovementCount,
  serverMutationCount,
  serverStockOnHand,
} from "./mutators.js";
import { POS_DDL, foldStock, posSchema } from "./schema.js";
import { posSyncRules } from "./sync-rules.js";

export const POS_SEED_SQL = `
  insert into locations (id, owner_id, name) values ('${POS_LOCATION_ID}', '${POS_OWNER_ID}', 'Front Store');
  insert into assets (id, location_id, name, sku, price, client_id)
    values ('${POS_ASSET_ID}', '${POS_LOCATION_ID}', 'Widget', 'W-1', '100', '${POS_ASSET_ID}');
`;

function posAuth(): NizhalAuth {
  return {
    async resolve() {
      return {
        userId: "terminal",
        ownerId: POS_OWNER_ID,
        locationId: POS_LOCATION_ID,
      };
    },
  };
}

export async function createPosChaosHarness(): Promise<ChaosHarness> {
  return createChaosHarness({
    schema: posSchema,
    syncRules: posSyncRules,
    mutatorsFactory: createPosMutators,
    ddl: POS_DDL,
    auth: posAuth(),
    seedSql: POS_SEED_SQL,
    bucketKey: POS_LOCATION_ID,
  });
}

async function bootPosClients(harness: ChaosHarness, count: number, persist = true) {
  const clients: ChaosClientHandle[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `terminal-${i + 1}`;
    const client = await harness.createClient({
      id,
      userId: id,
      ownerId: POS_OWNER_ID,
      bucket: POS_LOCATION_ID,
      actorExtras: { locationId: POS_LOCATION_ID },
      persist,
      mutators: createPosMutators(harness.poisoned),
      buildCollections: ({ echo, persistence }) => buildPosCollections({ echo, persistence }),
    });
    await Promise.all(Object.values(client.collections).map((c) => c.preload()));
    await client.executor.waitForInit();
    clients.push(client);
  }
  return clients;
}

function requireClient(
  clients: ChaosClientHandle[],
  index: number,
  label: string,
): ChaosClientHandle {
  const client = clients[index];
  if (!client) throw new Error(`missing chaos client: ${label}`);
  return client;
}

function posMutate(client: ChaosClientHandle) {
  return client.mutate as {
    ringSale: (args: {
      clientId: string;
      items: Array<{ assetId: string; qty: number; movementClientId: string }>;
    }) => void;
    receiveStock: (args: { clientId: string; assetId: string; qty: number }) => void;
    updateProductName: (args: { assetId: string; value: string }) => void;
    updateProductSku: (args: { assetId: string; value: string }) => void;
  };
}

export async function runPos1(): Promise<void> {
  const harness = await createPosChaosHarness();
  try {
    const clients = await bootPosClients(harness, 2);
    const a = requireClient(clients, 0, "a");
    const b = requireClient(clients, 1, "b");
    harness.partition(a.id);
    harness.partition(b.id);

    posMutate(a).ringSale({
      clientId: "sale-a",
      items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: "mov-a" }],
    });
    posMutate(b).ringSale({
      clientId: "sale-b",
      items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: "mov-b" }],
    });

    harness.heal(a.id);
    harness.heal(b.id);
    await harness.converge();

    const stock = await serverStockOnHand(harness.db, POS_LOCATION_ID, POS_ASSET_ID);
    if (stock !== -2) {
      throw new Error(`POS-1 INV-4: expected stock fold -2, got ${stock}`);
    }
    const movements = await harness.db.query(
      "select client_id from stock_movements where reason = 'sale'",
    );
    if (movements.rows.length !== 2) {
      throw new Error(`POS-1 INV-5: expected 2 accepted sales, got ${movements.rows.length}`);
    }
    await harness.assertInvariants({
      tables: ["assets", "stock_movements"],
      bucket: POS_LOCATION_ID,
    });
  } finally {
    await harness.close();
  }
}

export async function runPos2(): Promise<void> {
  const harness = await createPosChaosHarness();
  try {
    const terminal = requireClient(await bootPosClients(harness, 1), 0, "terminal");
    harness.partition(terminal.id);

    for (let i = 0; i < 50; i += 1) {
      posMutate(terminal).ringSale({
        clientId: `sale-${i}`,
        items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: `mov-${i}` }],
      });
    }

    harness.heal(terminal.id);
    await harness.converge();

    const count = await serverMovementCount(harness.db, POS_LOCATION_ID);
    if (count !== 50) {
      throw new Error(`POS-2 INV-2: expected 50 movements, got ${count}`);
    }
    await harness.assertInvariants({
      tables: ["stock_movements"],
      bucket: POS_LOCATION_ID,
    });
  } finally {
    await harness.close();
  }
}

export async function runPos3(): Promise<void> {
  const harness = await createPosChaosHarness();
  try {
    const terminal = requireClient(await bootPosClients(harness, 1), 0, "terminal");

    for (let i = 0; i < 20; i += 1) {
      if (i % 2 === 0) harness.partition(terminal.id);
      else harness.heal(terminal.id);
      posMutate(terminal).ringSale({
        clientId: `flap-${i}`,
        items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: `flap-mov-${i}` }],
      });
    }

    harness.heal(terminal.id);
    await harness.converge();

    const count = await serverMovementCount(harness.db, POS_LOCATION_ID);
    if (count !== 20) {
      throw new Error(`POS-3 INV-2: expected 20 movements, got ${count}`);
    }
    await harness.assertInvariants({
      tables: ["stock_movements"],
      bucket: POS_LOCATION_ID,
    });
  } finally {
    await harness.close();
  }
}

export async function runPos4(): Promise<void> {
  const harness = await createPosChaosHarness();
  try {
    const terminal = requireClient(await bootPosClients(harness, 1), 0, "terminal");
    posMutate(terminal).ringSale({
      clientId: "restart-sale",
      items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: "restart-mov" }],
    });
    await harness.restartServer();
    harness.heal(terminal.id);
    await harness.converge(45_000);

    const count = await serverMovementCount(harness.db, POS_LOCATION_ID);
    if (count !== 1) {
      throw new Error(`POS-4 INV-1: expected 1 movement after restart, got ${count}`);
    }
    await harness.assertInvariants({
      tables: ["stock_movements"],
      bucket: POS_LOCATION_ID,
    });
  } finally {
    await harness.close();
  }
}

export async function runPos5(): Promise<void> {
  const harness = await createPosChaosHarness();
  try {
    const terminal = requireClient(await bootPosClients(harness, 1), 0, "terminal");
    const mutation = {
      name: "ringSale",
      args: {
        clientId: "dup-sale-1",
        items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: "dup-mov" }],
      },
      clientID: "race-client",
      mutationID: 1,
      clientMutationId: "dup-sale-1",
      hlc: "2026-01-01T00:00:00.000Z-0000-0000000000000001",
    };
    await harness.raceConcurrent([
      async () => {
        await terminal.echo.push(mutation);
      },
      async () => {
        await terminal.echo.push(mutation);
      },
    ]);
    await harness.converge();

    const applied = await serverMutationCount(harness.db, "dup-sale-1");
    if (applied !== 1) {
      throw new Error(`POS-5 INV-3: expected 1 applied mutation, got ${applied}`);
    }
  } finally {
    await harness.close();
  }
}

export async function runPos6(): Promise<void> {
  const harness = await createPosChaosHarness();
  try {
    harness.poison("ringSale");
    const client = await harness.createClient({
      id: "poison-terminal",
      userId: "terminal",
      ownerId: POS_OWNER_ID,
      bucket: POS_LOCATION_ID,
      actorExtras: { locationId: POS_LOCATION_ID },
      persist: true,
      mutators: createPosMutators(harness.poisoned),
      buildCollections: ({ echo, persistence }) => buildPosCollections({ echo, persistence }),
    });
    await Promise.all(Object.values(client.collections).map((c) => c.preload()));
    await client.executor.waitForInit();

    posMutate(client).ringSale({
      clientId: "poison-sale",
      items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: "poison-mov" }],
    });

    await waitFor(() => client.deadLetter.length > 0, 15_000);

    posMutate(client).ringSale({
      clientId: "good-sale",
      items: [{ assetId: POS_ASSET_ID, qty: 1, movementClientId: "good-mov" }],
    });

    harness.unpoison("ringSale");
    await harness.converge();

    const good = await harness.db.query("select * from stock_movements where client_id = $1", [
      "good-mov",
    ]);
    if (good.rows.length !== 1) {
      throw new Error("POS-6 INV-8: good sale did not drain");
    }
    const poison = await harness.db.query("select * from stock_movements where client_id = $1", [
      "poison-mov",
    ]);
    if (poison.rows.length !== 0) {
      throw new Error("POS-6 INV-8: poison sale must not land on server");
    }
  } finally {
    await harness.close();
  }
}

export async function runPos7(): Promise<void> {
  const harness = await createPosChaosHarness();
  try {
    const a = await harness.createClient({
      id: "terminal-1",
      userId: "terminal-1",
      ownerId: POS_OWNER_ID,
      bucket: POS_LOCATION_ID,
      actorExtras: { locationId: POS_LOCATION_ID },
      persist: true,
      hlcSkewMs: 60_000,
      mutators: createPosMutators(harness.poisoned),
      buildCollections: ({ echo, persistence }) => buildPosCollections({ echo, persistence }),
    });
    const b = await harness.createClient({
      id: "terminal-2",
      userId: "terminal-2",
      ownerId: POS_OWNER_ID,
      bucket: POS_LOCATION_ID,
      actorExtras: { locationId: POS_LOCATION_ID },
      persist: true,
      mutators: createPosMutators(harness.poisoned),
      buildCollections: ({ echo, persistence }) => buildPosCollections({ echo, persistence }),
    });
    await Promise.all([
      ...Object.values(a.collections).map((c) => c.preload()),
      ...Object.values(b.collections).map((c) => c.preload()),
    ]);
    await Promise.all([a.executor.waitForInit(), b.executor.waitForInit()]);

    harness.partition(a.id);
    harness.partition(b.id);

    posMutate(a).updateProductName({ assetId: POS_ASSET_ID, value: "Renamed-A" });
    posMutate(b).updateProductSku({ assetId: POS_ASSET_ID, value: "SKU-B" });

    harness.heal(a.id);
    harness.heal(b.id);
    await harness.converge();

    const asset = await harness.db.query<{ name: string; sku: string | null }>(
      "select name, sku from assets where id = $1",
      [POS_ASSET_ID],
    );
    const row = asset.rows[0];
    if (row?.name !== "Renamed-A" || row?.sku !== "SKU-B") {
      throw new Error(`POS-7 INV-1: field merge failed name=${row?.name} sku=${row?.sku}`);
    }
    await harness.assertInvariants({
      tables: ["assets"],
      bucket: POS_LOCATION_ID,
    });
  } finally {
    await harness.close();
  }
}

export const posScenarios = [
  { id: "POS-1", run: runPos1 },
  { id: "POS-2", run: runPos2 },
  { id: "POS-3", run: runPos3 },
  { id: "POS-4", run: runPos4 },
  { id: "POS-5", run: runPos5 },
  { id: "POS-6", run: runPos6 },
  { id: "POS-7", run: runPos7 },
] as const;

export function assertPosStockFold(
  movements: readonly { asset_id: string; qty: string | number; deleted_at?: unknown }[],
  assetId: string,
  expected: number,
) {
  const folded = foldStock(movements as never, assetId);
  if (folded !== expected) {
    throw new Error(`stock fold expected ${expected}, got ${folded}`);
  }
}
