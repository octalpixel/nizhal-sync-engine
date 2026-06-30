import { describe, expect, it } from "vitest";
import { notesMutators } from "../src/mutators.js";
import { notesSyncRules } from "../src/sync-rules.js";

describe("@nizhal/example-notes", () => {
  it("exports owner-scoped sync rules and mutators", () => {
    expect(Object.keys(notesSyncRules)).toEqual(["myNotes"]);
    expect(Object.keys(notesMutators)).toEqual(["addNote", "editNote", "deleteNote"]);
  });
});
