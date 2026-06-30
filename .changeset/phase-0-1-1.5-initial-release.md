---
"@nizhal/kernel": minor
"@nizhal/server": minor
"@nizhal/db-collection": minor
"@nizhal/cli": minor
---

Initial public release covering Nizhal Phase 0, Phase 1, and Phase 1.5 hardening.

Phase 0: offline-sync engine with TanStack DB substrate, no-WAL Postgres provisioning, sync rules, mutators, poison-quarantine, and revocation eviction.

Phase 1: field-merge and CRDT columns, blob sync, presence v2, client-store persistence, reconnect/TTL, and observability hooks.

Phase 1.5: security regression coverage, Cloudflare realtime adapter, auth refresh, and release engineering (drizzle advisory cleared, changesets, publish config).
