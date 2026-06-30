import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// web-nizhal is a pnpm workspace member, so @nizhal/* + @tanstack/db resolve normally
// (single deduped copies — no aliases, no duplicate-package type clashes).
export default defineConfig({
  plugins: [react()],
  // wa-sqlite ships its own wasm + VFS sources; let Vite serve them instead of pre-bundling.
  optimizeDeps: { exclude: ["wa-sqlite"] },
  server: {
    port: 5174,
    proxy: { "/api": "http://localhost:8787" },
  },
});
