# Platforms — one core, two-piece adapters

The Nizhal client is platform-agnostic TypeScript: `openNizhalStore` (synced) and
`openLocalDb` (local-only), the push/pull engines, `watch`/`useLiveQuery`, and the transport
(standard `fetch` + `WebSocket`) run anywhere. A platform supplies exactly **two things**:

1. a **drizzle SQLite database** handle (the driver), and
2. a **`TableChangeSource`** (the SQLite update hook, for live queries).

There is no per-framework fork. The React hook (`@nizhal/local/react`) is plain React 18+;
`watch()` itself is framework-free (Vue/Svelte/vanilla bring their own binding).

## The matrix

| Target | Driver | Change feed | Status |
|---|---|---|---|
| Expo native (iOS/Android) | `drizzle-orm/op-sqlite` or `drizzle-orm/expo-sqlite` | `opSqliteChanges` / `expoSqliteChanges` (`@nizhal/local`) | shipped — `apps/tabkeep-expo` |
| Expo **web** (Metro) | `waSqliteDrizzle` (`@nizhal/local/wa-sqlite`) | `waSqliteChanges` | shipped + verified live — `apps/tabkeep-expo` (see Metro note) |
| **Vite** (plain React) | `waSqliteDrizzle` | `waSqliteChanges` | shipped + verified live — `playground/local-notes` |
| Next.js | `waSqliteDrizzle` | `waSqliteChanges` | recipe below (same driver; client-only boot) |
| TanStack Router / Start | `waSqliteDrizzle` | `waSqliteChanges` | recipe below (Vite-based; Start adds the SSR rule) |

## The browser database (all web targets)

wa-sqlite over an **IndexedDB-backed VFS** (`IDBBatchAtomicVFS`): durable across reloads and —
unlike OPFS/`SharedArrayBuffer` approaches — needs **no COOP/COEP headers**. The bootstrap every
web app performs (a `@nizhal/local` helper collapsing this to one call is planned):

```ts
import * as SQLite from "wa-sqlite";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";
import { waSqliteChanges, waSqliteDrizzle } from "@nizhal/local/wa-sqlite";

const module = await SQLiteESMFactory();           // see per-bundler loading below
const sqlite3 = SQLite.Factory(module);
const vfs = new IDBBatchAtomicVFS("my-app-vfs");
sqlite3.vfs_register(vfs, true);
const dbId = await sqlite3.open_v2(
  "my-app.db",
  SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
  vfs.name,
);
const database = waSqliteDrizzle({ sqlite3, database: dbId, config: { schema } });
const changes = waSqliteChanges(sqlite3, dbId);
```

Feed `{ database, changes }` into `openNizhalStore` (synced) or `openLocalDb` (local-only).

### Loading the wasm engine, per bundler

The one bundler-sensitive line is how `SQLiteESMFactory` (the emscripten glue) is loaded:

- **Vite / TanStack Start**: import it normally — Vite handles the ESM + wasm natively.
  ```ts
  import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
  import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
  const module = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  ```
  Add `optimizeDeps: { exclude: ["wa-sqlite"] }` to `vite.config`. Working reference:
  `playground/local-notes`.

- **Metro (Expo web)**: Metro cannot process the glue's `import.meta.url` (no import-meta
  transform exists in Metro 0.84). Copy `wa-sqlite-async.mjs` + `.wasm` into `public/` and load
  with a browser-native dynamic import that Metro can't rewrite:
  ```ts
  const nativeImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
  const { default: SQLiteESMFactory } = await nativeImport("/wa-sqlite-async.mjs");
  const module = await SQLiteESMFactory(); // wasm resolves next to the .mjs
  ```
  Working reference: `apps/tabkeep-expo/src/persistence.ts`. Caveat: `new Function` needs CSP
  `unsafe-eval`; on strict-CSP deployments replace it with a 3-line static loader module served
  from `public/`.

- **Next.js**: put the two files in `/public` and use the same native-import pattern, or a
  `next/dynamic`-loaded client module importing the package directly (webpack/turbopack handle
  `import.meta`). Untested in-repo; the driver itself is bundler-independent.

## SSR frameworks (Next.js, TanStack Start): the one structural rule

The store is a **browser object** — SQLite, IndexedDB, wasm — so it opens client-side only:

- Next App Router: a `'use client'` provider that boots the store in an effect and renders
  local data immediately.
- TanStack Start: a client-only route segment / `createIsomorphicFn` client branch.

This is not a Nizhal limitation; it is what offline-first means under SSR: the server renders
the shell, the device owns the data. The server side of these frameworks can still host the
Nizhal sync server (it's a Hono app) or proxy to one.

## Known follow-ups

- `@nizhal/local` web bootstrap helper (`openWebDatabase({ name, wasmUrl })`) to collapse the
  boilerplate above.
- Multi-tab coordination (SharedWorker-owned connection) — matters most for exactly these web
  frameworks; scoped in `SESSION-HANDOFF.md` follow-ups.
- The COOP/COEP alternative: `expo-sqlite`'s official web support (OPFS/`SharedArrayBuffer`)
  would allow one official driver across Expo native + web, at the cost of deployment-wide
  cross-origin-isolation headers. Deliberately not adopted while the header tax outweighs the
  benefit; revisit if tabkeep standardizes on expo-sqlite.
