import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["wa-sqlite"] },
  server: {
    port: 5175,
    proxy: {
      "/demo": "http://127.0.0.1:4521",
      "/nizhal": "http://127.0.0.1:4521",
      "/sync": { target: "http://127.0.0.1:4521", ws: true },
    },
  },
});
