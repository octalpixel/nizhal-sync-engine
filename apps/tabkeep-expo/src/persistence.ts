import type { TabkeepDatabase } from "./persistence.native";

// Web: no SQLite database wired yet — the drizzle-native store requires one (there is no
// in-memory collections fallback anymore; one standard). The wa-sqlite-under-Metro bundle is the
// recorded follow-up; until then tabkeep-expo is native-first and App.tsx shows a pending screen.
export async function openTabkeepDatabase(): Promise<TabkeepDatabase | undefined> {
  return undefined;
}
