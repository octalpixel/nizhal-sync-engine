declare module "wa-sqlite/dist/wa-sqlite.mjs" {
  function SQLiteFactory(options?: { wasmBinary?: Uint8Array }): Promise<unknown>;
  export default SQLiteFactory;
}
