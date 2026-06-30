// wa-sqlite ships no types; declare the surface we use (mirrors the proven test wiring).
declare module "wa-sqlite/dist/wa-sqlite-async.mjs" {
  const factory: (opts?: { locateFile?: (file: string) => string }) => Promise<unknown>;
  export default factory;
}
declare module "wa-sqlite" {
  export function Factory(module: unknown): any;
  export const SQLITE_ROW: number;
  export const SQLITE_DONE: number;
  export const SQLITE_OPEN_READWRITE: number;
  export const SQLITE_OPEN_CREATE: number;
}
declare module "wa-sqlite/src/examples/IDBBatchAtomicVFS.js" {
  export class IDBBatchAtomicVFS {
    constructor(idbDatabaseName?: string, options?: unknown);
    readonly name: string;
  }
}
