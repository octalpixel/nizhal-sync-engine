declare module "*.sql" {
  const content: string;
  export default content;
}

// wa-sqlite's shipped types don't line up with bundler resolution; declare the surface we
// use (same pattern as chat-nizhal), typed against @nizhal/local's structural API.
declare module "wa-sqlite" {
  import type { WaSqliteApiLike } from "@nizhal/local/wa-sqlite";
  export function Factory(module: unknown): WaSqliteApiLike & {
    open_v2(name: string, flags?: number, vfsName?: string): Promise<number>;
    vfs_register(vfs: { name: string }, makeDefault?: boolean): void;
  };
  export const SQLITE_ROW: number;
  export const SQLITE_DONE: number;
  export const SQLITE_OPEN_READWRITE: number;
  export const SQLITE_OPEN_CREATE: number;
}

declare module "wa-sqlite/dist/wa-sqlite-async.mjs" {
  const factory: (opts?: { locateFile?: (file: string) => string }) => Promise<unknown>;
  export default factory;
}

declare module "wa-sqlite/src/examples/IDBBatchAtomicVFS.js" {
  export class IDBBatchAtomicVFS {
    constructor(idbDatabaseName?: string, options?: unknown);
    readonly name: string;
  }
}
