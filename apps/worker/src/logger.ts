export type Logger = {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
};

const formatError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

export const createConsoleLogger = (scope = 'worker'): Logger => ({
  info: (message) => console.log(`[${scope}] ${message}`),
  error: (message, error) =>
    console.error(
      error === undefined
        ? `[${scope}] ${message}`
        : `[${scope}] ${message}\n${formatError(error)}`,
    ),
});
