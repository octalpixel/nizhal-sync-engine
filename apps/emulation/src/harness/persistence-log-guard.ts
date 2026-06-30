const PERSISTENCE_ERROR =
  /BEGIN IMMEDIATE|bad parameter|API misuse|SQLITE_MISUSE|outbox storage is disposed|dead-letter storage is disposed|Failed to persist/i;

function formatLogArgs(args: ReadonlyArray<unknown>): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === "string") {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

export function capturePersistenceLogErrors(): {
  messages: string[];
  restore(): void;
} {
  const messages: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;

  const capture =
    (level: "warn" | "error", original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const message = formatLogArgs(args);
      if (PERSISTENCE_ERROR.test(message)) {
        messages.push(`[${level}] ${message}`);
      }
      original(...args);
    };

  console.warn = capture("warn", originalWarn);
  console.error = capture("error", originalError);

  return {
    messages,
    restore() {
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}
