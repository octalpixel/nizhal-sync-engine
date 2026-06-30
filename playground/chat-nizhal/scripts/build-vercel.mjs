// Assemble a Vercel Build Output API deploy for the chat server: esbuild-bundle the serverless handler
// (externalizing the Worker-only cloudflare:workers import) into a single self-contained function so
// Vercel never has to resolve the pnpm workspace. Then `vercel deploy --prebuilt --prod`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const FUNC = ".vercel/output/functions/index.func";
rmSync(".vercel/output", { recursive: true, force: true });
mkdirSync(FUNC, { recursive: true });

await build({
  entryPoints: ["api/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: `${FUNC}/index.mjs`,
  external: ["cloudflare:workers"],
  // postgres-js / some deps reach for require() under ESM — shim it.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

writeFileSync(
  `${FUNC}/.vc-config.json`,
  JSON.stringify({ runtime: "nodejs20.x", handler: "index.mjs", launcherType: "Nodejs" }, null, 2),
);
writeFileSync(
  ".vercel/output/config.json",
  JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/index" }] }, null, 2),
);
console.log("Build Output assembled at .vercel/output");
