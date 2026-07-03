// Serverless outbox drain (H6). A long-running host runs runJobsOnce() in a poll loop from listen();
// serverless has no such loop, so a Vercel Cron GETs this every few minutes to run tombstone GC and any
// mutator-enqueued jobs one pass. Guarded by CRON_SECRET (Vercel Cron sends `Authorization: Bearer …`).
import { createNizhalServer } from "@nizhal/server";
import { serverConfig } from "../domain.mjs";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 403;
    return res.end("forbidden");
  }
  const server = createNizhalServer(serverConfig());
  const ran = await server.runJobsOnce();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ran }));
}
