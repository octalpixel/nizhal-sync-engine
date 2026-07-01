import { customers, ledgerEntries, tabkeepSyncRules } from "./src/domain";

// `nizhal migrate --config nizhal.config.ts --db <postgres-url>` provisions the Nizhal engine onto
// Tabkeep's existing business tables (customers, ledger_entries). Schema + sync rules come straight
// from the transport-free domain — the same declarations the client (src/client.ts) is built from,
// so the server and the client can never drift. `nizhal reset --yes` reprovisions from clean.
export default {
  schema: { customers, ledgerEntries },
  syncRules: tabkeepSyncRules,
};
