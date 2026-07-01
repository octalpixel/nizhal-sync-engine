import { openLocalDb } from "@nizhal/local";
import { waSqliteChanges, waSqliteDrizzle } from "@nizhal/local/wa-sqlite";
import { desc, eq } from "drizzle-orm";
import * as SQLite from "wa-sqlite";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";
import migrations from "../drizzle/migrations.js";
import * as schema from "./schema.js";

const { notes } = schema;

async function boot() {
  // Standard wa-sqlite bootstrap: IndexedDB-backed VFS, durable across reloads.
  const sqliteModule = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  const sqlite3 = SQLite.Factory(sqliteModule);
  const vfs = new IDBBatchAtomicVFS("local-notes-vfs");
  sqlite3.vfs_register(vfs, true);
  const database = await sqlite3.open_v2(
    "local-notes.db",
    SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
    vfs.name,
  );

  // The whole @nizhal/local surface: a migrated, reactive, real drizzle db.
  const local = await openLocalDb({
    db: waSqliteDrizzle({ sqlite3, database, config: { schema } }),
    migrations,
    changes: waSqliteChanges(sqlite3, database),
    close: () => sqlite3.close(database),
  });

  const status = document.querySelector("#status") as HTMLParagraphElement;
  const list = document.querySelector("#notes") as HTMLUListElement;
  const form = document.querySelector("#add-form") as HTMLFormElement;
  const input = document.querySelector("#add-input") as HTMLInputElement;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    await local.db.insert(notes).values({ id: crypto.randomUUID(), body, createdAt: Date.now() });
  });

  // Live query: re-renders on every write via the SQLite update hook — no manual refresh.
  local.watch(local.db.select().from(notes).orderBy(desc(notes.createdAt)), ({ data, error }) => {
    if (error) {
      status.textContent = `error: ${error.message}`;
      return;
    }
    status.textContent = `${data?.length ?? 0} note(s) — persisted in SQLite, live via update_hook`;
    list.replaceChildren(
      ...(data ?? []).map((note) => {
        const item = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = note.body;
        const remove = document.createElement("button");
        remove.textContent = "delete";
        // Drizzle builders are lazy — they execute on await/.then, so don't `void` them.
        remove.addEventListener("click", async () => {
          await local.db.delete(notes).where(eq(notes.id, note.id));
        });
        item.append(text, remove);
        return item;
      }),
    );
  });
}

void boot();
