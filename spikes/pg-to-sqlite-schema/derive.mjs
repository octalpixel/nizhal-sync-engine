// The load-bearing claim under test: a kernel pgTable schema can be mechanically derived
// into a client sqliteTable schema — one definition, two dialects (RFC "schema-once").
import { getTableColumns, getTableName } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Map one drizzle pg-core column to a sqlite-core builder.
 * Fail-closed: unsupported types throw with the column named, so a schema either derives
 * fully or tells you exactly which column needs a decision.
 */
function deriveColumn(column) {
  const name = column.name;
  switch (column.columnType) {
    case "PgText":
      return column.enumValues?.length ? text(name, { enum: column.enumValues }) : text(name);
    case "PgVarchar":
    case "PgChar":
    case "PgUUID":
      return text(name);
    case "PgInteger":
    case "PgSmallInt":
    case "PgSerial":
    case "PgSmallSerial":
    case "PgBigInt53":
    case "PgBigSerial53":
      return integer(name);
    case "PgBoolean":
      return integer(name, { mode: "boolean" });
    case "PgTimestamp": // mode: "date" — store epoch ms client-side, revive as Date
      return integer(name, { mode: "timestamp_ms" });
    case "PgTimestampString": // mode: "string" — keep the string form
    case "PgDate":
    case "PgDateString":
      return text(name);
    case "PgJson":
    case "PgJsonb":
      return text(name, { mode: "json" });
    case "PgNumeric": // exact decimal — keep textual to avoid float drift (money should be integer cents)
      return text(name);
    case "PgReal":
    case "PgDoublePrecision":
      return real(name);
    default:
      throw new Error(`unsupported pg column type '${column.columnType}' for column '${name}'`);
  }
}

/** Derive `{ [exportKey]: sqliteTable }` from a pgTable schema module. */
export function deriveSqliteSchema(pgSchema) {
  const out = {};
  for (const [key, table] of Object.entries(pgSchema)) {
    if (!table || typeof table !== "object" || !(getTableNameSafe(table))) continue;
    const columns = {};
    for (const [columnKey, column] of Object.entries(getTableColumns(table))) {
      let derived = deriveColumn(column);
      if (column.primary) derived = derived.primaryKey();
      else if (column.notNull) derived = derived.notNull();
      // Server-side defaults (defaultNow, defaultRandom) are deliberately NOT mirrored:
      // on the client, values come from the server pull or from mutators.
      columns[columnKey] = derived;
    }
    out[key] = sqliteTable(getTableName(table), columns);
  }
  return out;
}

function getTableNameSafe(table) {
  try {
    return getTableName(table);
  } catch {
    return undefined;
  }
}
