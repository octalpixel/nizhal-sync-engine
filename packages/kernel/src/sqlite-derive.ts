import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type {
  AnySQLiteColumn,
  SQLiteColumnBuilderBase,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A derived client table: a real drizzle sqlite table whose row types mirror the source pg table
 * ($inferSelect/$inferInsert are preserved — the lowering picks sqlite column modes that keep the
 * same JS types: timestamptz→Date, boolean→boolean, jsonb→object). Columns are exposed so the
 * drizzle query builder (`eq(t.col, …)`, `db.select().from(t)`) works against the derived table.
 */
export type DerivedSqliteTable<T extends Table> = SQLiteTable & {
  [K in keyof T["_"]["columns"]]: AnySQLiteColumn;
} & {
  $inferSelect: InferSelectModel<T>;
  $inferInsert: InferInsertModel<T>;
};

export type DerivedSqliteSchema<S extends Record<string, unknown>> = {
  [K in keyof S as S[K] extends Table ? K : never]: S[K] extends Table
    ? DerivedSqliteTable<S[K]>
    : never;
};

export interface DeriveSqliteSchemaOptions {
  /** Per-column escape hatch, keyed `"<sqlTableName>.<sqlColumnName>"`. */
  overrides?: Record<string, SQLiteColumnBuilderBase>;
}

interface PgColumnLike {
  name: string;
  columnType: string;
  primary: boolean;
  notNull: boolean;
  hasDefault: boolean;
  enumValues?: string[];
}

function deriveColumn(tableName: string, column: PgColumnLike): SQLiteColumnBuilderBase {
  const name = column.name;
  switch (column.columnType) {
    case "PgText":
      return column.enumValues?.length
        ? text(name, { enum: column.enumValues as [string, ...string[]] })
        : text(name);
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
    case "PgTimestamp": // mode "date" — epoch ms client-side, revives as Date
      return integer(name, { mode: "timestamp_ms" });
    case "PgTimestampString":
    case "PgDate":
    case "PgDateString":
      return text(name);
    case "PgJson":
    case "PgJsonb":
      return text(name, { mode: "json" });
    case "PgNumeric": // exact decimal — textual to avoid float drift (money should be integer cents)
      return text(name);
    case "PgReal":
    case "PgDoublePrecision":
      return real(name);
    default:
      throw new Error(
        `[@nizhal/kernel] deriveSqliteSchema: unsupported pg column type '${column.columnType}' ` +
          `for '${tableName}.${name}' — pass an override for "${tableName}.${name}"`,
      );
  }
}

/**
 * Mechanically lower a drizzle pg schema module to client sqlite tables — the schema-once story:
 * apps define `pgTable` once (the kernel dialect) and the device schema is derived, never written.
 * Fail-closed: an unmapped column type throws with the exact override key to set.
 * Server-side defaults are intentionally not mirrored (client values come from pull or mutators).
 */
export function deriveSqliteSchema<S extends Record<string, unknown>>(
  pgSchema: S,
  options?: DeriveSqliteSchemaOptions,
): DerivedSqliteSchema<S> {
  const out: Record<string, SQLiteTable> = {};
  for (const [key, value] of Object.entries(pgSchema)) {
    if (!is(value, Table)) continue;
    const tableName = getTableName(value);
    const columns: Record<string, SQLiteColumnBuilderBase> = {};
    for (const [columnKey, column] of Object.entries(getTableColumns(value))) {
      const pgColumn = column as unknown as PgColumnLike;
      const override = options?.overrides?.[`${tableName}.${pgColumn.name}`];
      let derived = override ?? deriveColumn(tableName, pgColumn);
      if (pgColumn.primary) {
        derived = (derived as unknown as { primaryKey(): SQLiteColumnBuilderBase }).primaryKey();
      } else if (pgColumn.notNull && !pgColumn.hasDefault) {
        // A server-defaulted column (defaultNow, …) cannot be NOT NULL on the client: mutators
        // legitimately omit it (the server fills it authoritatively; pull brings the real value).
        derived = (derived as unknown as { notNull(): SQLiteColumnBuilderBase }).notNull();
      }
      columns[columnKey] = derived;
    }
    out[key] = sqliteTable(tableName, columns);
  }
  return out as DerivedSqliteSchema<S>;
}

/** The single-column primary key of a derived (or any) drizzle table; throws if absent/composite. */
export function tablePrimaryKeyColumn(table: Table): { key: string; name: string } {
  const primaries = Object.entries(getTableColumns(table)).filter(
    ([, column]) => (column as unknown as { primary: boolean }).primary,
  );
  const first = primaries[0];
  if (!first || primaries.length !== 1) {
    throw new Error(
      `[@nizhal/kernel] table '${getTableName(table)}' needs exactly one primary-key column ` +
        `(found ${primaries.length}) — the sync engine keys rows by their primary key`,
    );
  }
  return { key: first[0], name: (first[1] as unknown as { name: string }).name };
}
