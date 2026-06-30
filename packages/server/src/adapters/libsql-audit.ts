import {
  type Client,
  type Config,
  type InValue,
  type Transaction,
  createClient,
} from "@libsql/client";
import type { AuditEntry, AuditQuery, PendingAuditEntry } from "./storage.js";

export interface LibsqlAuditStorage {
  provision(input: { audit?: boolean }): Promise<void>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  nextRowVersion(tx: Transaction): Promise<bigint>;
  appendAudit(tx: Transaction, entry: PendingAuditEntry): Promise<void>;
  getAuditLog(query: AuditQuery): Promise<AuditEntry[]>;
  close(): void;
}

export interface LibsqlAuditStorageOptions extends Config {
  client?: Client;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

export function libsqlAuditStorage(options: LibsqlAuditStorageOptions): LibsqlAuditStorage {
  const client = options.client ?? createClient(options);
  const nextRowVersion = async (tx: Transaction): Promise<bigint> => {
    const result = await tx.execute("insert into _nizhal_row_versions default values");
    if (result.lastInsertRowid === undefined) {
      throw new Error("libSQL did not return an audit row version");
    }
    return result.lastInsertRowid;
  };
  return {
    async provision(input) {
      if (input.audit === false) return;
      await client.executeMultiple(`
        create table if not exists _nizhal_row_versions (
          row_version integer primary key autoincrement
        );
        create table if not exists _nizhal_audit_log (
          row_version integer primary key,
          client_mutation_id text not null,
          mutation_name text not null,
          args text not null check (json_valid(args)),
          actor text not null check (json_valid(actor)),
          client_id text,
          mutation_id integer,
          hlc text,
          affected_buckets text not null check (json_valid(affected_buckets)),
          created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        create index if not exists _nizhal_audit_log_created_at_idx
          on _nizhal_audit_log (created_at);
      `);
    },
    async transaction(fn) {
      const tx = await client.transaction("write");
      try {
        const result = await fn(tx);
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    },
    nextRowVersion,
    async appendAudit(tx, entry) {
      const rowVersion = await nextRowVersion(tx);
      await tx.execute({
        sql: `insert into _nizhal_audit_log (
          row_version, client_mutation_id, mutation_name, args, actor,
          client_id, mutation_id, hlc, affected_buckets
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          rowVersion,
          entry.clientMutationId,
          entry.mutationName,
          stringifyJson(entry.args, "args"),
          stringifyJson(entry.actor, "actor"),
          entry.clientId,
          entry.mutationId,
          entry.hlc,
          stringifyJson(entry.affectedBuckets, "affectedBuckets"),
        ],
      });
    },
    async getAuditLog(query) {
      const conditions: string[] = [];
      const args: InValue[] = [];
      if (query.sinceVersion !== undefined) {
        conditions.push("row_version > ?");
        args.push(parseVersion(query.sinceVersion));
      }
      if (query.untilVersion !== undefined) {
        conditions.push("row_version <= ?");
        args.push(parseVersion(query.untilVersion));
      }
      if (query.actor !== undefined) {
        for (const [key, value] of Object.entries(query.actor)) {
          conditions.push("json_extract(actor, ?) = json_extract(?, '$')");
          args.push(`$.${JSON.stringify(key)}`, stringifyJson(value, `actor.${key}`));
        }
      }
      if (query.buckets !== undefined && query.buckets.length > 0) {
        conditions.push(
          `exists (
            select 1 from json_each(_nizhal_audit_log.affected_buckets)
            where json_each.value in (${query.buckets.map(() => "?").join(", ")})
          )`,
        );
        args.push(...query.buckets);
      }
      args.push(normalizeLimit(query.limit));
      const result = await client.execute({
        sql: `select row_version, client_mutation_id, mutation_name, args, actor,
          client_id, mutation_id, hlc, affected_buckets, created_at
          from _nizhal_audit_log
          ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
          order by row_version asc
          limit ?`,
        args,
      });
      return result.rows.map((row) => ({
        rowVersion: integerString(row.row_version, "row_version"),
        clientMutationId: requiredString(row.client_mutation_id, "client_mutation_id"),
        mutationName: requiredString(row.mutation_name, "mutation_name"),
        args: parseJson(row.args, "args"),
        actor: objectJson(row.actor, "actor"),
        clientId: nullableString(row.client_id, "client_id"),
        mutationId: nullableInteger(row.mutation_id, "mutation_id"),
        hlc: nullableString(row.hlc, "hlc"),
        affectedBuckets: stringArrayJson(row.affected_buckets, "affected_buckets"),
        createdAt: requiredString(row.created_at, "created_at"),
      }));
    },
    close() {
      if (!options.client) client.close();
    },
  };
}

function stringifyJson(value: unknown, field: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`Audit ${field} is not JSON-serializable`);
  return json;
}

function parseVersion(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid audit row version '${value}'`);
  return BigInt(value);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1)
    throw new Error("Audit limit must be a positive integer");
  return Math.min(value, MAX_LIMIT);
}

function parseJson(value: InValue | undefined, field: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored audit ${field} is not JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Stored audit ${field} is invalid JSON`);
  }
}

function objectJson(value: InValue | undefined, field: string): Record<string, unknown> {
  const parsed = parseJson(value, field);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Stored audit ${field} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function stringArrayJson(value: InValue | undefined, field: string): string[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`Stored audit ${field} is not a string array`);
  }
  return parsed;
}

function requiredString(value: InValue | undefined, field: string): string {
  if (typeof value !== "string") throw new Error(`Stored audit ${field} is not text`);
  return value;
}

function nullableString(value: InValue | undefined, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function nullableInteger(value: InValue | undefined, field: string): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Stored audit ${field} is not a safe integer`);
  return number;
}

function integerString(value: InValue | undefined, field: string): string {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`Stored audit ${field} is not an integer`);
  }
  return value.toString();
}
