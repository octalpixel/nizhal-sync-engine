---
title: "Sync modes: local-first vs server-authoritative"
description: The one decision that shapes how your Nizhal app behaves — who is the source of truth, the device or the server. Explained from first principles.
---

Everything about how a Nizhal app *feels* comes down to one question:

> **When you write something, who do you believe — the device or the server?**

Nizhal lets you answer that per app (and even per collection) with one option, `mode`. There are
exactly two answers, and once you pick one, everything else (offline behavior, conflicts, what can
break) follows from it. So let's build both answers up from scratch.

## A shopping list, two ways

Imagine two flatmates keeping a shared shopping list.

**Way 1 — everyone has their own notebook.** Each person writes into *their own* notebook the instant
they think of something. No asking permission, no signal required — you can add "milk" standing in a
basement car park. Later, when the flatmates are in the same room, they **reconcile**: copy each
other's new items across. Your notebook is *the truth for you*; meeting up is just syncing.

**Way 2 — one whiteboard at the front door.** There's a single master list on a whiteboard. You can
scribble a sticky note ("milk?") so you don't forget, but it isn't *really* on the list until someone
walks to the door and copies it onto the whiteboard. If two people scribble conflicting things, the
whiteboard is the tie-breaker. In the basement, your sticky notes pile up — and you won't know which
survived until you're back at the door.

That's the whole idea:

- **Way 1 is `local-first`** — the device's local database is the source of truth.
- **Way 2 is `server-authoritative`** — the server's database is the source of truth.

Nizhal defaults to **`local-first`**, because that's the answer that keeps working when the network
doesn't.

---

## Mode 1 — `local-first` (the default)

**The promise:** your local SQLite store is the truth. A write is *done* the moment it lands there —
durably, on the device — whether or not a server exists, whether or not you're online, whether or not
you ever reload.

Walk through what actually happens when the user taps "add note":

1. The mutator runs **on the device** and the row is **committed to local SQLite immediately** (this
   is the real meaning of "source of truth" — the row isn't a temporary overlay, it's *the data*).
2. The same write is recorded in a **durable outbox** (a persisted command log).
3. If a server is configured, the outbox **replays** to it when reachable. If not, the write just…
   stays. It's already real.
4. Reload the page, kill the app, fly with no signal for a week — the row is still there, because it
   was never waiting on anyone.

You can run this mode **with no server at all** — `server` is optional. That's a fully offline,
durable, reactive app out of the box. Add a server later and it starts syncing with zero changes to
your app code.

### What syncing does here: "pull-as-merge" behind an acknowledgement barrier

This is the subtle part, so let's go slowly. When a server *is* connected, two streams of truth meet:
your un-synced local writes, and the authoritative rows the server sends back on `pull`. If the server
just overwrote everything, it would erase the note you typed two seconds ago that hasn't uploaded yet.

So local-first sync **merges** instead of overwrites, with one rule — the **acknowledgement barrier**:

> The server's version of a row replaces your local version **only after the server has acknowledged
> your own pending write to that row.** Until then, your local write wins and stays visible.

In notebook terms: when you reconcile notebooks, you don't let your flatmate erase the line you just
wrote and haven't shown them yet. You only accept their version of a line once they've *seen* yours.
The result: offline writes are never silently lost, and once the round-trip completes, everyone
converges on the server's authoritative row.

(In the code this is `applyLocalFirstPullResult` — a merge that can momentarily *block* a row's
replacement while a local write for it is still in flight.)

### Where local-first costs you something

- The optimistic result the user sees is *your* computation, which may differ slightly from what the
  server finally decides (a total, a derived field). The next pull reconciles it — see [Optimistic
  approximation](/guides/bring-your-own-backend/) for how to choose what to predict vs. mark "pending".
- "The device is truth" means a lost/wiped device is a lost queue until it syncs. The durable outbox +
  idempotent replay make this safe across reloads and crashes, but the device is genuinely a first-class
  participant, not just a cache.

---

## Mode 2 — `server-authoritative` (opt-in)

**The promise:** the server is the truth. The local store is a fast **cache + optimistic overlay** —
great for instant UI and read-while-briefly-offline, but a write isn't "real" until the server says so.

What happens on "add note":

1. The mutator runs optimistically on the device so the UI updates instantly (the sticky note).
2. The write goes to the server; on `pull`, the server's authoritative rows **replace** the local copy
   (the whiteboard wins). There's no ack-barrier merge — pull is replacement (`applyPullResult`).
3. Because the server is the truth, **this mode requires a server.** Constructing a
   `server-authoritative` collection without one throws — there's no whiteboard to believe.

This is how most "online app with a nice offline cache" products work. It's the right choice when the
server *must* be the final word and brief offline is a convenience, not a hard requirement.

### Where server-authoritative costs you something

- Go offline for real and writes are in limbo — queued, but not "true," and the server can still reject
  or reshape them on reconnect.
- No ack-barrier protection: the model is "server wins," so you design around the server being able to
  overwrite the optimistic UI.

---

## Side by side

| | `local-first` (default) | `server-authoritative` (opt-in) |
|---|---|---|
| Source of truth | the **device's** local SQLite | the **server's** database |
| A write is "done" when… | it hits local SQLite (instantly) | the server accepts it |
| Needs a server? | **No** (optional — add to sync) | **Yes** (throws without one) |
| Offline writes | durable, real, survive reload | queued, provisional |
| What `pull` does | **merges** behind an ack barrier (never clobbers un-acked local writes) | **replaces** local with server state |
| Mental model | everyone's notebook + reconcile | one whiteboard at the door |
| Best for | offline-first, field apps, local-first products, "works on a plane" | online apps where the server must be final word |

---

## Choosing (and how to set it)

Default to **`local-first`** unless you have a specific reason the server must be the final authority
before a write counts. It's the only mode that makes "works offline" *true* rather than *best-effort*.

```ts
// app-wide default
const echo = createNizhalClient({
  mode: "local-first",          // omittable — this is the default
  server: "https://api.example.com",  // optional in local-first; required in server-authoritative
  bucketsForSyncRule: () => [ownerId],
});

// or override per collection
nizhalCollectionOptions({ name: "ledger", syncRule: "myLedger", echo, mode: "server-authoritative", getKey: r => r.id });
```

You can mix: most collections `local-first`, and a money-movement collection `server-authoritative`
where you'd rather the write block on the server than be optimistically wrong.

## Common confusions

- **"local-first means no server."** No — it means the *device* is the truth. You usually still run a
  server; it just becomes a sync/replication peer rather than the gatekeeper. Running with no server is
  a *supported special case* of local-first, not its definition.
- **"server-authoritative is safer."** It's not safer, it's *different* — it trades guaranteed offline
  durability for a guaranteed single source of truth. Money movement wants it; a notes app does not.
- **"Optimistic = local-first."** Both modes are optimistic (instant UI). The difference is what
  happens to that optimistic row on `pull`: local-first *merges and protects* it; server-authoritative
  *replaces* it.

## Where to go next

- [How sync works](/concepts/how-sync-works/) — cursors, tombstones, idempotency under the hood.
- [Conflict resolution](/concepts/conflict-resolution/) — what "the server's version" actually means per row.
- [Bring your own backend](/guides/bring-your-own-backend/) — the optimistic full/light/pending spectrum.
