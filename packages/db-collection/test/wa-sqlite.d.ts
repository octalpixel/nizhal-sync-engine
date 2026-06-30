declare module "wa-sqlite/dist/wa-sqlite.mjs" {
  function SQLiteFactory(options?: { wasmBinary?: Uint8Array }): Promise<unknown>;
  export default SQLiteFactory;
}

declare module "wa-sqlite/src/examples/MemoryVFS.js" {
  export class MemoryVFS {
    name: string;
    constructor();
    close(): void;
  }
}
