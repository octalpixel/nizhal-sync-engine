import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { exclude: ["wa-sqlite"] },
  server: { port: 5180 },
});
