// Tiny zero-dependency static server for the cross-tab harness. Serves the harness page + the tsc build
// (packages/db-collection/dist) as native ES modules, so a real browser (driven via Argent) can load the
// actual coordinator source with no bundler. Run: node serve.mjs  (or PORT=5178 node serve.mjs).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "..", "dist");
const contentType = (file) =>
  file.endsWith(".js")
    ? "text/javascript"
    : file.endsWith(".html")
      ? "text/html"
      : file.endsWith(".map")
        ? "application/json"
        : "application/octet-stream";

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  let file;
  if (path === "/") file = join(here, "index.html");
  else if (path === "/harness.js") file = join(here, "harness.js");
  else if (path.startsWith("/dist/")) file = join(distDir, path.slice("/dist/".length));
  else {
    res.statusCode = 404;
    return res.end("not found");
  }
  try {
    const body = readFileSync(file);
    res.setHeader("content-type", contentType(file));
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

const port = Number(process.env.PORT ?? "5178");
server.listen(port, "127.0.0.1", () => {
  console.log(`nizhal cg harness on http://127.0.0.1:${port}/?tab=A  (and ?tab=B in a second tab)`);
});
