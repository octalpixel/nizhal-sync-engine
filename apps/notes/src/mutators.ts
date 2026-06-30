import { type MutatorFn, defineMutator, defineMutators } from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { notes } from "./schema.js";

export const addNoteInput = z.object({
  clientId: z.string(),
  title: z.string().min(1),
  body: z.string(),
});

export const editNoteInput = z.object({
  noteId: z.string(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
});

export const deleteNoteInput = z.object({
  noteId: z.string(),
});

export const addNote: MutatorFn<z.infer<typeof addNoteInput>> = async (
  { tx, ownerId, newId },
  args,
) => {
  const id = args.clientId || newId();
  await tx.insert(notes).values({
    id,
    owner_id: ownerId,
    title: args.title,
    body: args.body,
  });
  return { serverId: id, affectedBuckets: [ownerId] };
};

export const editNote: MutatorFn<z.infer<typeof editNoteInput>> = async ({ tx, ownerId }, args) => {
  const patch: { title?: string; body?: string } = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.body !== undefined) patch.body = args.body;
  if (Object.keys(patch).length === 0) {
    throw new Error("editNote requires title and/or body");
  }
  await tx.update(notes).set(patch).where(eq(notes.id, args.noteId));
  return { affectedBuckets: [ownerId] };
};

export const deleteNote: MutatorFn<z.infer<typeof deleteNoteInput>> = async (
  { tx, ownerId },
  args,
) => {
  await tx.delete(notes).where(eq(notes.id, args.noteId));
  return { affectedBuckets: [ownerId] };
};

export const notesMutators = defineMutators({
  addNote: defineMutator(addNoteInput, addNote),
  editNote: defineMutator(editNoteInput, editNote),
  deleteNote: defineMutator(deleteNoteInput, deleteNote),
});
