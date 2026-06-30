import { customType } from "drizzle-orm/pg-core";
import { type Table, getTableName, isTable } from "drizzle-orm/table";
import { getTableColumns } from "drizzle-orm/utils";
import { createSelectSchema } from "./drizzle-zod.js";
import type { MergeMode, MergePolicy, Schema } from "./types.js";

export type NizhalTable = Table;
export interface NizhalTableSource {
  table: NizhalTable;
  merge?: MergeMode;
}

export type ContractSchemaSource =
  | NizhalTable
  | NizhalTableSource
  | Schema<unknown>
  | { jsonSchema: unknown }
  | { schema: Schema<unknown> }
  | { rowSchema: Schema<unknown> };

export function isNizhalTable(source: unknown): source is NizhalTable {
  return isTable(source);
}

export function tableName(table: NizhalTable): string {
  return getTableName(table);
}

export function isNizhalTableSource(source: unknown): source is NizhalTableSource {
  return (
    typeof source === "object" &&
    source !== null &&
    "table" in source &&
    isNizhalTable((source as { table?: unknown }).table)
  );
}

export function schemaTableName(source: ContractSchemaSource, fallbackName: string): string {
  if (isNizhalTable(source)) return tableName(source);
  if (isNizhalTableSource(source)) return tableName(source.table);
  return fallbackName;
}

export function schemaMergeMode(source: ContractSchemaSource): MergeMode {
  if (isNizhalTableSource(source)) return source.merge ?? "lww";
  return "lww";
}

export function schemaMergePolicy(source: ContractSchemaSource): MergePolicy {
  const tableMode = schemaMergeMode(source);
  const table = isNizhalTable(source)
    ? source
    : isNizhalTableSource(source)
      ? source.table
      : undefined;
  const columnModes = isNizhalTable(table)
    ? tableColumnMergeModes(table)
    : new Map<string, MergeMode>();
  if (columnModes.size === 0) return tableMode;
  const policy: Record<string, MergeMode> = {};
  if (tableMode !== "lww") policy._ = tableMode;
  for (const [column, mode] of columnModes) {
    policy[column] = mode;
  }
  return policy;
}

export function tableColumns(table: NizhalTable): ReturnType<typeof getTableColumns> {
  return getTableColumns(table);
}

export function tableSelectSchema(table: NizhalTable): Schema<unknown> {
  return createSelectSchema(table);
}

export function tableColumnMergeModes(table: NizhalTable): Map<string, MergeMode> {
  const modes = new Map<string, MergeMode>();
  for (const column of Object.values(getTableColumns(table))) {
    const fieldConfig = (column as unknown as { config?: { fieldConfig?: { merge?: MergeMode } } })
      .config?.fieldConfig;
    if (fieldConfig?.merge) {
      modes.set((column as { name: string }).name, fieldConfig.merge);
    }
  }
  return modes;
}

const crdtColumn = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
  config: { merge: "crdt"; root: "text" | "map" };
  configRequired: true;
}>({
  dataType() {
    return "bytea";
  },
});

export function crdtText(name: string) {
  return crdtColumn(name, { merge: "crdt", root: "text" });
}

export function crdtMap(name: string) {
  return crdtColumn(name, { merge: "crdt", root: "map" });
}

export {
  bigint,
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
