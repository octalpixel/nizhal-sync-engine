---
title: Set up with your agent
description: Point a coding agent at Nizhal — it asks a few scoping questions, then scaffolds the sync stack for your project.
---

Two ways to get Nizhal into a project: let your coding agent set it up, or do it yourself.

## Option A — let your agent do it

Paste this into Claude Code, Codex, or any coding agent **from your project folder**:

```text
Read https://nizhal-docs.pages.dev/start.md then set up Nizhal for this project.
```

The agent reads [`start.md`](https://nizhal-docs.pages.dev/start.md) and runs a **two-phase** setup:

1. **Scope it** — it asks you five quick questions (one at a time, with recommended defaults; say *"use defaults"* to accept all):
   - **What are you building?** the core data that syncs → drives schema, mutators, sync rules.
   - **Platforms?** web / React Native / both → wa-sqlite vs op-sqlite.
   - **Postgres?** bring your own connection string — any Postgres works (Supabase, Neon, RDS, self-hosted) — or local Docker for dev. No provider is assumed.
   - **Conflict model?** LWW *(default)* / per-field merge / CRDT.
   - **Realtime?** in-process *(default)* / Postgres LISTEN-NOTIFY / Cloudflare.
2. **Scaffold** — it installs `@nizhal/*`, models your domain (Drizzle schema + `defineMutators` + `defineSyncRules`), provisions Postgres with `nizhal migrate`, wires `createNizhalServer` + a TanStack DB client, and runs a convergence smoke.

This is intentionally light — project scoping, not a design interview. You can correct any answer; nothing is committed without your say.

## Option B — set up yourself

Prefer to drive it manually? Follow the [Quickstart](/getting-started/quickstart/) — same steps, your hands on the keyboard.

## What "scoped" means

The five answers map directly to real choices in the stack:

| Answer | What it sets |
|--------|--------------|
| Domain | The Drizzle schema, `defineMutators`, and `defineSyncRules` |
| Platforms | `waSqlitePersistence` (web) and/or `opSqlitePersistence` + `@nizhal/react-native` (RN) |
| Postgres | `postgresStorage({ connectionString })` + `nizhal migrate` |
| Conflict model | `merge: "lww" \| "field" \| "crdt"` per table (LWW is the default) |
| Realtime | `inProcessRealtime` / `listenNotifyRealtime` / `cloudflareRealtime` |

See [How sync works](/concepts/how-sync-works/) and [Conflict resolution](/concepts/conflict-resolution/) for the why behind each.
