export interface StorageOperationQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  whenIdle(): Promise<void>;
}

export function createStorageOperationQueue(): StorageOperationQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const run = tail.then(operation, operation);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    whenIdle() {
      return tail;
    },
  };
}
