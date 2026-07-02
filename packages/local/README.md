# @nizhal/local

Purely-local native-Drizzle store for [Nizhal](https://github.com/octalpixel/nizhal) apps —
**no server, no sync**. WatermelonDB-class DX with the Drizzle toolkit exposed natively: a
`sqliteTable` schema, drizzle-kit migrations applied on-device, the real Drizzle query builder,
and cross-platform live queries (expo-sqlite / op-sqlite / browser wa-sqlite).

```bash
npm install @nizhal/local
```

```ts
import { openLocalDb } from "@nizhal/local";
import { expoSqliteChanges } from "@nizhal/local/expo-sqlite";
import { useLiveQuery } from "@nizhal/local/react";
import { drizzle } from "drizzle-orm/expo-sqlite";
import * as SQLite from "expo-sqlite";
import migrations from "./drizzle/migrations";
import * as schema from "./schema";

const expo = SQLite.openDatabaseSync("app.db", { enableChangeListener: true });
const local = await openLocalDb({ db: drizzle(expo, { schema }), migrations, changes: expoSqliteChanges(SQLite) });
// in a component: const { data } = useLiveQuery(local, local.db.select().from(schema.notes));
```

Full guide (incl. op-sqlite / wa-sqlite / Vite / Next recipes): [`docs/local.md`](../../docs/local.md). MIT licensed.
