# @nizhal/cli

The `nizhal` command for [Nizhal](https://github.com/octalpixel/nizhal) — provisions the no-WAL
sync engine (plain columns, triggers, indexes, sidecar tables) onto your **existing** Postgres
tables from your schema + sync rules. No replication slot, no `wal_level` change.

```bash
npm install -D @nizhal/cli
```

```bash
nizhal migrate      # provision the sync engine onto your Postgres (reads a nizhal.config)
nizhal reset        # re-provision (new server epoch) — dev only
nizhal gen          # (planned) generate client types from GET /nizhal/contract
nizhal introspect   # (planned) brownfield schema introspection
```

`nizhal migrate` provisions onto tables you already created (run your own ORM/SQL migrations
first). Config exports `{ db, schema, syncRules, storage? }`.
Full API: [`docs/api.md`](../../docs/api.md#nizhalcli). MIT licensed.
