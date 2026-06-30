import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Actor, BucketKey, SyncRules } from "@nizhal/kernel";
import { collectSyncRuleTables } from "@nizhal/kernel";
import { AwsClient } from "aws4fetch";
import { inArray, sql } from "drizzle-orm";
import type { NizhalDb } from "../drizzle-db.js";
import { executeRows, toNizhalDb } from "../drizzle-db.js";

export interface BlobPresignUpload {
  url: string;
  method: "PUT";
  headers?: Record<string, string>;
  key: string;
}

export interface BlobPresignDownload {
  url: string;
}

export interface BlobAdapter {
  presignUpload(input: {
    key: string;
    mime: string;
    maxBytes: number;
    expiresInSec?: number;
  }): Promise<BlobPresignUpload>;
  presignDownload(input: { key: string; expiresInSec?: number }): Promise<BlobPresignDownload>;
  delete(input: { key: string }): Promise<void>;
  head?(input: { key: string }): Promise<{ exists: boolean; size?: number }>;
}

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  client?: AwsClient;
  accessKeyId?: string;
  secretAccessKey?: string;
}

const DEFAULT_EXPIRES_SECONDS = 300;

function awsClient(opts: {
  client?: AwsClient;
  accessKeyId?: string;
  secretAccessKey?: string;
  service?: string;
  region?: string;
}): AwsClient {
  if (opts.client) return opts.client;
  const accessKeyId = opts.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = opts.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
  if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string") {
    throw new Error(
      "[@nizhal/server] s3BlobStore requires accessKeyId/secretAccessKey or an AwsClient",
    );
  }
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: opts.service,
    region: opts.region,
  });
}

function objectUrl(bucket: string, region: string, key: string): string {
  if (region === "auto") {
    return `https://${bucket}.r2.cloudflarestorage.com/${encodeKey(key)}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodeKey(key)}`;
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function presign(
  client: AwsClient,
  method: string,
  url: string,
  headers: Record<string, string>,
  expiresInSec: number,
  awsOptions?: { service?: string; region?: string },
): Promise<{ url: string; headers: Record<string, string> }> {
  const signedUrl = new URL(url);
  signedUrl.searchParams.set("X-Amz-Expires", String(expiresInSec));
  const signed = await client.sign(signedUrl.toString(), {
    method,
    headers,
    aws: { signQuery: true, service: awsOptions?.service, region: awsOptions?.region },
  });
  const resultHeaders: Record<string, string> = {};
  signed.headers.forEach((value, key) => {
    resultHeaders[key] = value;
  });
  return { url: signed.url.toString(), headers: resultHeaders };
}

export function s3BlobStore(opts: S3BlobStoreOptions): BlobAdapter {
  const client = awsClient({
    client: opts.client,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    service: "s3",
    region: opts.region,
  });

  async function signedUrl(
    method: string,
    key: string,
    mime: string | undefined,
    expiresInSec: number,
  ): Promise<string> {
    const headers: Record<string, string> = mime ? { "content-type": mime } : {};
    const { url } = await presign(
      client,
      method,
      objectUrl(opts.bucket, opts.region, key),
      headers,
      expiresInSec,
      { service: "s3", region: opts.region },
    );
    return url;
  }

  return {
    async presignUpload(input) {
      const expiresInSec = input.expiresInSec ?? DEFAULT_EXPIRES_SECONDS;
      const url = await signedUrl("PUT", input.key, input.mime, expiresInSec);
      return { url, method: "PUT", headers: { "content-type": input.mime }, key: input.key };
    },
    async presignDownload(input) {
      const expiresInSec = input.expiresInSec ?? DEFAULT_EXPIRES_SECONDS;
      const url = await signedUrl("GET", input.key, undefined, expiresInSec);
      return { url };
    },
    async delete(input) {
      const response = await client.fetch(objectUrl(opts.bucket, opts.region, input.key), {
        method: "DELETE",
        aws: { service: "s3", region: opts.region },
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`s3 delete failed: ${response.status}`);
      }
    },
    async head(input) {
      const response = await client.fetch(objectUrl(opts.bucket, opts.region, input.key), {
        method: "HEAD",
        aws: { service: "s3", region: opts.region },
      });
      if (response.status === 404) return { exists: false };
      if (!response.ok) throw new Error(`s3 head failed: ${response.status}`);
      const length = response.headers.get("content-length");
      return { exists: true, size: length ? Number(length) : undefined };
    },
  };
}

export interface R2BlobStoreOptions {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2BlobStore(opts: R2BlobStoreOptions): BlobAdapter {
  return s3BlobStore({
    bucket: opts.bucket,
    region: "auto",
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
  });
}

export interface LocalFsBlobStoreOptions {
  root: string;
  publicBaseUrl: string;
  secret?: string;
}

export interface LocalFsBlobStore extends BlobAdapter {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  verifyToken(key: string, token: string, expires: string, method: string): boolean;
}

export function localFsBlobStore(opts: LocalFsBlobStoreOptions): LocalFsBlobStore {
  const root = path.resolve(opts.root);
  const baseUrl = opts.publicBaseUrl.replace(/\/$/, "");
  const secret = opts.secret ?? process.env.NIZHAL_BLOB_SECRET ?? "";
  if (secret.length === 0) {
    throw new Error("[@nizhal/server] localFsBlobStore requires a secret");
  }

  function filePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(root, safe);
  }

  function signToken(key: string, expires: number, method: string): string {
    return createHmac("sha256", secret).update(`${key}:${expires}:${method}`).digest("base64url");
  }

  function presignedUrl(key: string, method: "PUT" | "GET"): string {
    const expires = Math.floor(Date.now() / 1000) + DEFAULT_EXPIRES_SECONDS;
    const token = signToken(key, expires, method);
    return `${baseUrl}/nizhal/blob/${encodeURIComponent(key)}?token=${token}&expires=${expires}&method=${method}`;
  }

  return {
    async presignUpload(input) {
      return {
        url: presignedUrl(input.key, "PUT"),
        method: "PUT",
        headers: { "content-type": input.mime },
        key: input.key,
      };
    },
    async presignDownload(input) {
      return { url: presignedUrl(input.key, "GET") };
    },
    async delete(input) {
      try {
        await fs.unlink(filePath(input.key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async head(input) {
      try {
        const stat = await fs.stat(filePath(input.key));
        return { exists: true, size: Number(stat.size) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
        throw error;
      }
    },
    async read(key) {
      try {
        const buffer = await fs.readFile(filePath(key));
        return new Uint8Array(buffer);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(key, stream) {
      await fs.mkdir(root, { recursive: true });
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const blob = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        blob.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await fs.writeFile(filePath(key), blob);
    },
    verifyToken(key, token, expires, method) {
      const expiryMs = Number(expires) * 1000;
      if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return false;
      const expected = signToken(key, Number(expires), method);
      try {
        return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
      } catch {
        return false;
      }
    },
  };
}

export interface BlobRefLookupResult {
  table: string;
  bucketColumn: string;
  bucketValue: BucketKey;
}

export async function findBlobRef(
  db: NizhalDb,
  actor: Actor,
  syncRules: SyncRules,
  id: string,
): Promise<BlobRefLookupResult | null> {
  const allowedBuckets = new Set(localActorBucketKeys(actor, syncRules));
  const tables = collectSyncRuleTables(syncRules);
  for (const { table, bucketColumns } of tables.values()) {
    for (const bucketColumn of bucketColumns) {
      const rows = await executeRows<Record<string, unknown>>(
        db,
        sql`select ${sql.identifier(bucketColumn)} as bucket from ${sql.identifier(table)} where id = ${id} and deleted_at is null limit 1`,
      );
      const bucket = rows[0]?.bucket;
      if (bucket !== undefined && bucket !== null) {
        const bucketValue = String(bucket);
        if (allowedBuckets.has(bucketValue)) {
          return { table, bucketColumn, bucketValue };
        }
      }
    }
  }
  return null;
}

function localActorBucketKeys(actor: Actor, syncRules: SyncRules): BucketKey[] {
  const keys = new Set<BucketKey>();
  for (const rule of Object.values(syncRules)) {
    const parameters = rule.parameters(actor);
    const bucketColumns = (parameters as { bucketColumns?: Record<string, string> }).bucketColumns;
    if (!bucketColumns) continue;
    for (const [bucketKey, column] of Object.entries(bucketColumns)) {
      const value = actorValue(actor, bucketKey, column);
      if (value !== undefined && value !== null) keys.add(String(value));
    }
  }
  return Array.from(keys);
}

function actorValue(actor: Actor, bucketKey: string, column: string): unknown {
  if (bucketKey in actor) return actor[bucketKey];
  const camelColumn = column.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (camelColumn in actor) return actor[camelColumn];
  if (column in actor) return actor[column];
  return undefined;
}

export function blobDb(storage: { getClient?(): unknown }): NizhalDb | null {
  const client = storage.getClient?.();
  if (!client) return null;
  return toNizhalDb(client as Parameters<typeof toNizhalDb>[0]).db;
}

export interface BlobGcTable {
  table: string;
  keyColumn: string;
}

export interface BlobGcTaskOptions {
  db: NizhalDb;
  blobAdapter: BlobAdapter;
  refTables: BlobGcTable[];
}

export function blobGcTask(options: BlobGcTaskOptions): {
  slug: string;
  run: () => Promise<void>;
} {
  const tableNames = options.refTables.map((t) => t.table);
  return {
    slug: "blob-gc",
    async run() {
      if (tableNames.length === 0) return;
      const tombstones = await executeRows<{ table_name: string; row_id: string }>(
        options.db,
        sql`select table_name, row_id from _nizhal_tombstones where ${inArray(sql.identifier("table_name"), tableNames)} group by table_name, row_id`,
      );
      for (const tombstone of tombstones) {
        const refTable = options.refTables.find((t) => t.table === tombstone.table_name);
        if (!refTable) continue;
        const stillReferenced = await executeRows<Record<string, unknown>>(
          options.db,
          sql`select 1 from ${sql.identifier(refTable.table)} where ${sql.identifier(refTable.keyColumn)} = ${tombstone.row_id} and deleted_at is null limit 1`,
        );
        if (stillReferenced.length === 0) {
          await options.blobAdapter.delete({ key: tombstone.row_id });
        }
      }
    },
  };
}
