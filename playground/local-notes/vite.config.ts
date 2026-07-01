import { readFileSync } from "node:fs";
import { type Plugin, defineConfig } from "vite";

// Vite twin of babel-plugin-inline-import: drizzle-kit's generated migrations.js imports the
// .sql files directly, so serve them as source strings.
function inlineSql(): Plugin {
  return {
    name: "inline-sql",
    enforce: "pre",
    load(id) {
      if (!id.endsWith(".sql")) return undefined;
      return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    },
  };
}

export default defineConfig({
  plugins: [inlineSql()],
  optimizeDeps: { exclude: ["wa-sqlite"] },
  server: { port: 5176 },
});
