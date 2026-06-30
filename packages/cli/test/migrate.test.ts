import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/index.js";

describe("@nizhal/cli migrate", () => {
  it("loads config and calls storage.provision", async () => {
    const dir = join(tmpdir(), `echo-cli-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, "nizhal.config.mjs");
    const markerPath = join(dir, "called.txt");
    await writeFile(
      configPath,
      `export default {
  schema: { ledger_entries: {} },
  syncRules: {},
  storage: {
    async provision(input) {
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(${JSON.stringify(markerPath)}, JSON.stringify({
          schema: Object.keys(input.schema),
          syncRules: Object.keys(input.syncRules)
        }))
      );
    }
  }
};`,
    );
    const logs: string[] = [];

    await migrate(
      ["--config", configPath],
      {},
      { log: (message) => logs.push(message), error: () => {} },
    );

    const marker = JSON.parse(await BunFileText(markerPath)) as {
      schema: string[];
      syncRules: string[];
    };
    expect(marker).toEqual({ schema: ["ledger_entries"], syncRules: [] });
    expect(logs).toEqual(["nizhal migrate complete"]);
  });

  it("loads a TypeScript config that re-exports .ts source (the documented nizhal.config.ts)", async () => {
    const dir = join(tmpdir(), `echo-cli-ts-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const markerPath = join(dir, "called.txt");
    // TS source the config imports with a `.js` specifier (TS/ESM convention) — exactly what plain
    // `node` cannot resolve from a `.ts` config, but the CLI's jiti loader can.
    await writeFile(
      join(dir, "schema.ts"),
      "export const ledgerSchema: Record<string, unknown> = { ledger_entries: {} };\n",
    );
    await writeFile(
      join(dir, "nizhal.config.ts"),
      `import { ledgerSchema } from "./schema.js";
const config = {
  schema: ledgerSchema,
  syncRules: {} as Record<string, unknown>,
  storage: {
    async provision(input: { schema: Record<string, unknown> }) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(${JSON.stringify(markerPath)}, JSON.stringify(Object.keys(input.schema)));
    },
  },
};
export default config;
`,
    );
    const logs: string[] = [];
    await migrate(
      ["--config", join(dir, "nizhal.config.ts")],
      {},
      { log: (message) => logs.push(message), error: () => {} },
    );
    expect(JSON.parse(await BunFileText(markerPath))).toEqual(["ledger_entries"]);
    expect(logs).toEqual(["nizhal migrate complete"]);
  });

  it("turns a missing-business-table provision failure into actionable guidance", async () => {
    const dir = join(tmpdir(), `echo-cli-missing-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, "nizhal.config.mjs");
    await writeFile(
      configPath,
      `export default {
  schema: { customers: {} },
  syncRules: {},
  storage: {
    async provision() {
      const err = new Error('relation "customers" does not exist');
      err.code = "42P01";
      throw err;
    }
  }
};`,
    );
    await expect(
      migrate(["--config", configPath], {}, { log: () => {}, error: () => {} }),
    ).rejects.toThrow(/provisions the sync engine onto your EXISTING tables/);
  });
});

async function BunFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
