import { createCloudflareSubscribeSource } from "@nizhal/db-collection";
import { App } from "./App.js";

// Cloudflare realtime demo: identical UI, but realtime fan-out is routed through a Cloudflare
// Durable Object instead of the Node server's in-process realtime. Pull/push still go to the Node
// data server; only the live "repull" ping travels worker → DO → browser.
//
// Run (see README → "Cloudflare realtime"): wrangler dev (worker) + `pnpm dev:server:cf` + `pnpm dev`,
// then open http://localhost:5175/cf in two windows.
const CF_REALTIME_HOST = import.meta.env.VITE_NIZHAL_REALTIME_HOST || "127.0.0.1:8787";

export function AppCF() {
  return (
    <App
      buildSubscribeSource={(session) =>
        createCloudflareSubscribeSource(CF_REALTIME_HOST, () => Promise.resolve(session.token))
      }
    />
  );
}
