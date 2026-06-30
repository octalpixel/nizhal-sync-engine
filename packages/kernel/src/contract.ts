import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type ContractSchemaSource,
  isNizhalTable,
  isNizhalTableSource,
  schemaMergePolicy,
  schemaTableName,
  tableSelectSchema,
} from "./schema.js";
import type { MutatorRegistry, NizhalContract, Schema, SyncRules } from "./types.js";

export interface EmitNizhalContractInput {
  title?: string;
  version?: string;
  schema: Record<string, ContractSchemaSource>;
  mutators: MutatorRegistry;
  syncRules: SyncRules;
}

export function emitNizhalContract(input: EmitNizhalContractInput): NizhalContract {
  const collections = Object.entries(input.schema).map(([name, source]) =>
    schemaTableName(source, name),
  );
  const schemas: Record<string, unknown> = {};
  const merge: NizhalContract["x-echo"]["merge"] = {};

  for (const [name, source] of Object.entries(input.schema)) {
    const tableName = schemaTableName(source, name);
    const schemaName = pascalCase(tableName);
    schemas[schemaName] = schemaSourceToJsonSchema(schemaName, source);
    merge[tableName] = schemaMergePolicy(source);
  }

  const mutators: NizhalContract["x-echo"]["mutators"] = {};
  for (const [name, mutator] of Object.entries(input.mutators)) {
    const schemaName = `${pascalCase(name)}Input`;
    const jsonSchema = zodSchemaToJsonSchema(schemaName, mutator.schema);
    schemas[schemaName] = jsonSchema;
    mutators[name] = { input: { $ref: `#/components/schemas/${schemaName}` } };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: input.title ?? "Nizhal Contract",
      version: input.version ?? "0.0.0",
    },
    components: { schemas },
    "x-echo": {
      collections,
      merge,
      mutators,
      syncRules: Object.keys(input.syncRules),
    },
  };
}

function schemaSourceToJsonSchema(name: string, source: ContractSchemaSource): unknown {
  if (isNizhalTable(source)) return zodSchemaToJsonSchema(name, tableSelectSchema(source));
  if (isNizhalTableSource(source))
    return zodSchemaToJsonSchema(name, tableSelectSchema(source.table));
  if ("jsonSchema" in source) return source.jsonSchema;
  if ("schema" in source) return zodSchemaToJsonSchema(name, source.schema);
  if ("rowSchema" in source) return zodSchemaToJsonSchema(name, source.rowSchema);
  return zodSchemaToJsonSchema(name, source);
}

function zodSchemaToJsonSchema(name: string, schema: Schema<unknown>): unknown {
  if (!("_def" in schema)) return {};
  const converted = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    name,
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  const definitions = converted.definitions as Record<string, unknown> | undefined;
  return definitions?.[name] ?? converted;
}

function pascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}
