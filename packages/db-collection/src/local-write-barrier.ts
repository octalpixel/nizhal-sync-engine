import type { PendingMutation } from "@tanstack/db";
import type { OfflineTransaction } from "@tanstack/offline-transactions";

export interface LocalWriteRow {
  collectionId: string;
  key: string;
  changedFields: ReadonlyArray<string>;
}

interface LocalWriteState {
  rows: LocalWriteRow[];
  phase: "pending" | "acknowledging";
}

export class LocalWriteBarrier {
  private readonly writes = new Map<string, LocalWriteState>();
  private bootstrap: Promise<void> = Promise.resolve();

  setBootstrap(bootstrap: Promise<ReadonlyArray<OfflineTransaction>>): void {
    this.bootstrap = bootstrap.then((transactions) => {
      for (const transaction of transactions) {
        this.register(transaction.id, rowsFromOfflineTransaction(transaction));
      }
    });
  }

  ready(): Promise<void> {
    return this.bootstrap;
  }

  register(transactionId: string, rows: ReadonlyArray<LocalWriteRow>): void {
    if (rows.length === 0) return;
    this.writes.set(transactionId, { rows: dedupeRows(rows), phase: "pending" });
  }

  isBlocked(collectionId: string, key: string): boolean {
    for (const write of this.writes.values()) {
      if (write.phase !== "pending") continue;
      if (write.rows.some((row) => row.collectionId === collectionId && row.key === key)) {
        return true;
      }
    }
    return false;
  }

  pendingFields(collectionId: string, key: string): ReadonlySet<string> {
    const fields = new Set<string>();
    for (const write of this.writes.values()) {
      if (write.phase !== "pending") continue;
      for (const row of write.rows) {
        if (row.collectionId !== collectionId || row.key !== key) continue;
        for (const field of row.changedFields) fields.add(field);
      }
    }
    return fields;
  }

  beginAcknowledgement(transactionId: string): ReadonlyArray<LocalWriteRow> {
    const write = this.writes.get(transactionId);
    if (!write) return [];
    write.phase = "acknowledging";
    return write.rows;
  }

  failAcknowledgement(transactionId: string): void {
    const write = this.writes.get(transactionId);
    if (write) write.phase = "pending";
  }

  completeAcknowledgement(transactionId: string): void {
    this.writes.delete(transactionId);
  }
}

export function rowsFromOfflineTransaction(
  transaction: Pick<OfflineTransaction, "mutations">,
): LocalWriteRow[] {
  return rowsFromMutations(transaction.mutations);
}

export function rowsFromMutations(mutations: ReadonlyArray<PendingMutation>): LocalWriteRow[] {
  return mutations.flatMap((mutation) => {
    const collectionId = mutation.collection?.id;
    const key = mutation.key;
    if (!collectionId || (typeof key !== "string" && typeof key !== "number")) return [];
    return [
      {
        collectionId,
        key: String(key),
        changedFields:
          mutation.type === "delete"
            ? ["*"]
            : mutation.type === "insert"
              ? Object.keys(mutation.modified)
              : Object.keys(mutation.changes),
      },
    ];
  });
}

function dedupeRows(rows: ReadonlyArray<LocalWriteRow>): LocalWriteRow[] {
  const merged = new Map<string, LocalWriteRow>();
  for (const row of rows) {
    const id = `${row.collectionId}\0${row.key}`;
    const existing = merged.get(id);
    merged.set(id, {
      ...row,
      changedFields: [...new Set([...(existing?.changedFields ?? []), ...row.changedFields])],
    });
  }
  return [...merged.values()];
}
