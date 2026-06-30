import type { MutatorRegistry } from "@nizhal/kernel";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import { smsReminderHandler } from "./jobs.js";
import { creditLedgerMutators } from "./mutators.js";
import { creditLedgerSchema } from "./schema.js";
import { creditLedgerSyncRules } from "./sync-rules.js";

export interface CreditLedgerServerOptions {
  db: string;
  secret: string;
}

export function createCreditLedgerServer(options: CreditLedgerServerOptions) {
  return createNizhalServer({
    db: options.db,
    schema: creditLedgerSchema,
    mutators: creditLedgerMutators as MutatorRegistry,
    syncRules: creditLedgerSyncRules,
    auth: bearerTokenAuth({ secret: options.secret }),
    jobs: {
      "sms-reminder": smsReminderHandler,
    },
  });
}
