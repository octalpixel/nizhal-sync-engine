// One-off: provision the Tabkeep engine (row-version triggers, _nizhal_* tables, audit) on a hosted
// Postgres. Business tables are applied separately via psql (TABKEEP_DDL). postgresStorage resolves
// its own postgres-js client from @nizhal/server.
import { postgresStorage } from "@nizhal/server/adapters";
import { tabkeepSchema } from "../src/schema.js";
import { tabkeepSyncRules } from "../src/sync-rules.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

const storage = postgresStorage({ connectionString: url });
await storage.provision({ schema: tabkeepSchema, syncRules: tabkeepSyncRules, audit: true });
console.log("engine provisioned (row-version triggers, _nizhal_* tables, audit)");
process.exit(0);
