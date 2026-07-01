#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContractSchemaSource, SyncRules } from "@nizhal/kernel";
import { type StorageAdapter, postgresStorage } from "@nizhal/server/adapters";
import { createJiti } from "jiti";

const notImplemented = (cmd: string, chunk: string): never => {
  throw new Error(`[@nizhal/cli] '${cmd}' not implemented — ${chunk}; see rfcs/RFC-001-nizhal.md`);
};

export interface NizhalMigrateConfig {
  db?: string;
  schema: Record<string, ContractSchemaSource>;
  syncRules: SyncRules;
  storage?: StorageAdapter;
  audit?: boolean;
}

interface Io {
  log(message: string): void;
  error(message: string): void;
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = console,
): Promise<void> {
  const cmd = argv[2];
  switch (cmd) {
    case "migrate":
      await migrate(argv.slice(3), env, io);
      break;
    case "reset":
      await reset(argv.slice(3), env, io);
      break;
    case "gen":
      notImplemented("gen", "C4 (typed client from GET /nizhal/contract)");
      break;
    case "introspect":
      notImplemented("introspect", "B9 (brownfield schema introspection)");
      break;
    default:
      io.log("nizhal <migrate|reset|gen|introspect>");
  }
}

export async function migrate(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = console,
): Promise<void> {
  const parsed = parseArgs(args);
  const config = await loadConfig(parsed.config ?? "nizhal.config.js");
  const connectionString = parsed.db ?? config.db ?? env.DATABASE_URL;
  const storage =
    config.storage ??
    postgresStorage({ connectionString: requireValue(connectionString, "database URL") });
  try {
    await storage.provision({
      schema: config.schema,
      syncRules: config.syncRules,
      audit: config.audit !== false,
    });
  } catch (error) {
    if (isMissingRelationError(error)) {
      throw new Error(
        "nizhal migrate provisions the sync engine onto your EXISTING tables — a synced table was not found. " +
          "Create your business schema (your ORM/SQL migrations) before running nizhal migrate. " +
          `Underlying: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
  io.log("nizhal migrate complete");
}

export async function reset(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = console,
): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed.yes) {
    throw new Error(
      "nizhal reset DROPS every engine artifact (_nizhal_* tables/functions + per-table row-version " +
        "columns/triggers) and reprovisions fresh — every client must re-sync from empty. Re-run with --yes to confirm.",
    );
  }
  const config = await loadConfig(parsed.config ?? "nizhal.config.js");
  const connectionString = parsed.db ?? config.db ?? env.DATABASE_URL;
  const storage =
    config.storage ??
    postgresStorage({ connectionString: requireValue(connectionString, "database URL") });
  if (!storage.reset) {
    throw new Error("nizhal reset is not supported by the configured storage adapter");
  }
  await storage.reset({
    schema: config.schema,
    syncRules: config.syncRules,
    audit: config.audit !== false,
  });
  io.log("nizhal reset complete");
}

/**
 * Postgres "undefined_table" (42P01) — a synced business table the provision plan expected is absent.
 * Walks the cause chain because the driver (drizzle over postgres-js) wraps the SQLSTATE under `.cause`.
 */
function isMissingRelationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "42P01") return true;
    const message = current instanceof Error ? current.message : "";
    if (/relation ".*" does not exist|does not exist/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function parseArgs(args: string[]): { config?: string; db?: string; yes?: boolean } {
  const parsed: { config?: string; db?: string; yes?: boolean } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") parsed.config = requireValue(args[++index], "--config value");
    else if (arg === "--db") parsed.db = requireValue(args[++index], "--db value");
    else if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else throw new Error(`Unknown nizhal option '${arg}'`);
  }
  return parsed;
}

async function loadConfig(path: string): Promise<NizhalMigrateConfig> {
  // Load through jiti so a TypeScript config (the documented `nizhal.config.ts`) and its own
  // `.ts`/`.js` source imports resolve without a separate build step — `node` alone can't import
  // a `.ts` config that re-exports compiled source. Resolve relative to the invoking cwd, not the CLI.
  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(resolve(process.cwd(), path))) as {
    default?: NizhalMigrateConfig;
    schema?: Record<string, ContractSchemaSource>;
    syncRules?: SyncRules;
    db?: string;
    storage?: StorageAdapter;
    audit?: boolean;
  };
  const config = mod.default ?? mod;
  if (!config.schema || !config.syncRules) {
    throw new Error("nizhal migrate config must export schema and syncRules");
  }
  return config as NizhalMigrateConfig;
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === "") throw new Error(`Missing ${label}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      // Exit explicitly: a storage adapter's connection pool (postgres-js) keeps the event loop
      // alive, so without this `nizhal migrate` would hang after finishing instead of returning.
      process.exit(1);
    });
}
