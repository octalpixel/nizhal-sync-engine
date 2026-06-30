export function toBindableWaSqliteValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      return [...value];
    }
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  throw new TypeError(
    `[@nizhal/db-collection] unsupported wa-sqlite bind parameter: ${typeof value}`,
  );
}

export function normalizeWaSqliteParams(
  params?: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> | undefined {
  if (params === undefined) {
    return undefined;
  }
  return params.map((param) => toBindableWaSqliteValue(param));
}

export function isSqliteDuplicateColumnAddError(error: unknown, sql: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (!sql.trim().toUpperCase().startsWith("ALTER TABLE")) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("duplicate column name") ||
    (message.includes("already exists") && message.includes("column"))
  );
}
