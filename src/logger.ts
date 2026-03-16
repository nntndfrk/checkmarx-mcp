export type LogLevel = "debug" | "info" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  error: 2,
};

const PREFIX = "[checkmarx-mcp]";

export class Logger {
  private readonly level: number;

  constructor(level: LogLevel = "info") {
    this.level = LEVEL_PRIORITY[level];
  }

  debug(message: string, data?: unknown): void {
    if (this.level <= LEVEL_PRIORITY.debug) {
      console.error(`${PREFIX} [DEBUG] ${message}`, ...(data !== undefined ? [data] : []));
    }
  }

  info(message: string, data?: unknown): void {
    if (this.level <= LEVEL_PRIORITY.info) {
      console.error(`${PREFIX} [INFO] ${message}`, ...(data !== undefined ? [data] : []));
    }
  }

  error(message: string, data?: unknown): void {
    if (this.level <= LEVEL_PRIORITY.error) {
      console.error(`${PREFIX} [ERROR] ${message}`, ...(data !== undefined ? [data] : []));
    }
  }
}

export function createLogger(): Logger {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const level: LogLevel = env === "debug" ? "debug" : env === "error" ? "error" : "info";
  return new Logger(level);
}
