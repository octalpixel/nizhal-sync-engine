import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// chat-nizhal is a pnpm workspace member, so @nizhal/* + @tanstack/db resolve normally.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["wa-sqlite"] },
  server: { port: 5175 },
});
