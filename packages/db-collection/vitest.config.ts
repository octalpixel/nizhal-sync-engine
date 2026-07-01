import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Each test file spins up its own PGlite (WASM Postgres) instances — several spin up many. Running
    // files in parallel oversubscribes the CPU and makes the heavy, timing-sensitive offline-sync repros
    // flake (timeouts + settle-window races). Run files sequentially for a deterministic suite; the heavy
    // repros are the slow part regardless, so the wall-clock cost is modest and worth the reliability.
    fileParallelism: false,
  },
});
