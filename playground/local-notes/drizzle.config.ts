import { defineConfig } from "drizzle-kit";

// `driver: "expo"` selects drizzle-kit's bundled-migrations output (`./drizzle/migrations.js`)
// — the same bundle @nizhal/local applies on expo-sqlite, op-sqlite, and browser wa-sqlite.
export default defineConfig({
  dialect: "sqlite",
  driver: "expo",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
