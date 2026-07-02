import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/index.js";

// P4 (T16): the `nizhal migrate` additive-only guard reads the previous synced-schema snapshot from
// engine meta and blocks a breaking change unless --allow-breaking. The pure diff matrix lives in
// @nizhal/kernel; this proves the migrate wiring end to end with a file-backed meta store.

// A v1 snapshot as a prior migrate would have recorded it: mig_notes(id text, body text).
const V1_SNAPSHOT = JSON.stringify({
  mig_notes: {
    id: { type: "text", notNull: true, hasDefault: false },
    body: { type: "text", notNull: false, hasDefault: false },
  },
});

async function scaffold(dir: string, metaFile: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(metaFile, JSON.stringify({ synced_schema: V1_SNAPSHOT }));
  // v2 config DROPS the synced `body` column (breaking) + a file-backed meta storage.
  const configPath = join(dir, "nizhal.config.mjs");
  await writeFile(
    configPath,
    `import { pgTable, text } from "drizzle-orm/pg-core";
import { defineSyncRules } from "@nizhal/kernel";
import { readFile, writeFile } from "node:fs/promises";
const META = ${JSON.stringify(metaFile)};
const mig_notes = pgTable("mig_notes", { id: text("id").primaryKey(), owner_id: text("owner_id").notNull() });
export default {
  schema: { mig_notes },
  syncRules: defineSyncRules((b) => ({
    ownerBucket: b.bucket({
      parameters: () => b.params({ ownerId: "owner_id" }),
      data: (bucket) => [b.table("mig_notes").where(b.eq("owner_id", bucket.ownerId))],
    }),
  })),
  storage: {
    async provision() {},
    async readEngineMeta(key) {
      try { return (JSON.parse(await readFile(META, "utf8")))[key] ?? null; } catch { return null; }
    },
    async writeEngineMeta(key, value) {
      let all = {};
      try { all = JSON.parse(await readFile(META, "utf8")); } catch {}
      all[key] = value;
      await writeFile(META, JSON.stringify(all));
    },
  },
};`,
  );
  return configPath;
}

describe("nizhal migrate additive-only guard (T16)", () => {
  it("blocks a breaking synced-schema change with an actionable message", async () => {
    const dir = join(tmpdir(), `nizhal-guard-${process.pid}-${Date.now()}`);
    const configPath = await scaffold(dir, join(dir, "meta.json"));
    await expect(
      migrate(["--config", configPath], {}, { log: () => {}, error: () => {} }),
    ).rejects.toThrow(/breaking synced-schema change|dropped or renamed/);
  });

  it("proceeds with --allow-breaking and updates the snapshot", async () => {
    const dir = join(tmpdir(), `nizhal-guard-ok-${process.pid}-${Date.now()}`);
    const metaFile = join(dir, "meta.json");
    const configPath = await scaffold(dir, metaFile);
    const logs: string[] = [];
    await migrate(
      ["--config", configPath, "--allow-breaking"],
      {},
      { log: (m) => logs.push(m), error: () => {} },
    );
    expect(logs.some((l) => /--allow-breaking/.test(l))).toBe(true);
    expect(logs).toContain("nizhal migrate complete");
    // the snapshot advanced to v2 (body dropped) — a re-run would now be additive
    const meta = JSON.parse(await readFile(metaFile, "utf8")) as { synced_schema: string };
    expect(JSON.parse(meta.synced_schema).mig_notes).not.toHaveProperty("body");
  });
});
