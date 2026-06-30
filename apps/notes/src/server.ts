import type { MutatorRegistry } from "@nizhal/kernel";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import { notesMutators } from "./mutators.js";
import { notesSchema } from "./schema.js";
import { notesSyncRules } from "./sync-rules.js";

export interface NotesServerOptions {
  db: string;
  secret: string;
}

export function createNotesServer(options: NotesServerOptions) {
  return createNizhalServer({
    db: options.db,
    schema: notesSchema,
    mutators: notesMutators as MutatorRegistry,
    syncRules: notesSyncRules,
    auth: bearerTokenAuth({ secret: options.secret }),
  });
}
