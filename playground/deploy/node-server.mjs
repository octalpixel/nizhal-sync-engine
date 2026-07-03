// Container / long-running Node entry (Docker, Fly.io, Railway, Render, AWS ECS/EC2, SST, bare Node).
// The default runtime: `createNizhalServer(...).listen(port)` binds an http server, attaches the WS
// upgrade handler, and installs the realtime notify triggers for you.
import { createNizhalServer } from "@nizhal/server";
import { ensureTable, serverConfig, syncRules } from "./domain.mjs";

const config = serverConfig();
await ensureTable(config.storage);
await config.storage.provision({ schema: {}, syncRules });
const server = createNizhalServer(config);
const port = Number(process.env.PORT ?? 4700);
server.listen(port);
console.log(`nizhal deploy (Node) → :${port}`);
