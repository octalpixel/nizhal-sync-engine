import { type SyncRuleBuilder, type SyncRules, defineSyncRules } from "@nizhal/kernel";

function buildNotesSyncRules(b: SyncRuleBuilder): SyncRules {
  return {
    myNotes: b.bucket({
      parameters: () => b.params({ ownerId: "owner_id" }),
      data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
    }),
  } as unknown as SyncRules;
}

export const notesSyncRules = defineSyncRules(buildNotesSyncRules);
