import { App } from "./App.js";

// Realtime / multi-device demo over the self-hosted Node server (in-process realtime, same-origin
// WS). This is the default App's transport made explicit as its own route — open it in two windows
// (or two browser profiles) and watch a write on one converge live on the other.
//
// Run (see README → "Realtime (self-hosted Node)"): `pnpm dev:server` + `pnpm dev`,
// then open http://localhost:5175/realtime in two windows.
export function AppRealtime() {
  return <App />;
}
