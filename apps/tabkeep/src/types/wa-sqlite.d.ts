declare module "wa-sqlite/dist/wa-sqlite-async.mjs" {
  const factory: (options?: { locateFile?: (file: string) => string }) => Promise<unknown>;
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
    constructor(databaseName?: string, options?: unknown);
    readonly name: string;
  }
}
