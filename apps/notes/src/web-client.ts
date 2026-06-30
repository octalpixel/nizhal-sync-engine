import type { NizhalCollection } from "@nizhal/db-collection";
import {
  createNizhalClient,
  createNizhalMutators,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { notesMutators } from "./mutators.js";
import type { NoteRow } from "./schema.js";

export interface NotesClientOptions {
  server: string;
  userId: string;
  ownerId: string;
  subscribeSource?: Parameters<typeof createNizhalClient>[0]["subscribeSource"];
}

export function createNotesClient(opts: NotesClientOptions) {
  const echo = createNizhalClient({
    server: opts.server,
    subscribeSource: opts.subscribeSource,
    bucketsForSyncRule: (rule) => (rule === "myNotes" ? [opts.ownerId] : []),
  });

  const notesCollection = createCollection(
    nizhalCollectionOptions<NoteRow>({
      name: "notes",
      syncRule: "myNotes",
      echo,
      bucketField: "owner_id",
      getKey: (row) => row.id,
    }),
  ) as NizhalCollection<NoteRow>;

  const { mutate, executor } = createNizhalMutators({
    collections: { notes: notesCollection } as Record<string, NizhalCollection<object>>,
    echo,
    actor: {
      userId: opts.userId,
      ownerId: opts.ownerId,
    },
    mutators: notesMutators,
  });

  return { notes: notesCollection, echo, mutate, executor };
}

export type NotesClient = ReturnType<typeof createNotesClient>;
