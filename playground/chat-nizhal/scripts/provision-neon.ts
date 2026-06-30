// Provision the chat schema + Nizhal engine (row-version triggers, _nizhal_* tables, audit) on a
// dedicated hosted Postgres (Neon). Idempotent: business tables are dropped + recreated (this is a
// dedicated `chat` database), then the engine is layered on via postgresStorage.provision.
import { postgresStorage } from "@nizhal/server/adapters";
import postgres from "postgres";
import { CHAT_DDL, chatSchema, chatSyncRules } from "../src/domain.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

const sql = postgres(url, { max: 1 });
await sql.unsafe("drop table if exists reactions, messages, channel_members, channels cascade");
await sql.unsafe(CHAT_DDL);
await sql.end();

const storage = postgresStorage({ connectionString: url });
await storage.provision({ schema: chatSchema, syncRules: chatSyncRules, audit: true });
console.log("chat schema + engine provisioned on Neon (row-version triggers, _nizhal_*, audit)");
process.exit(0);
