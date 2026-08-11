import type { LogLevel } from "./env.js";

export type LogData = Record<string, unknown>;

const levelRank: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Writes structured application events at or above a configured threshold. */
export class Logger {
  /**
   * Creates a logger.
   *
   * @param level - Minimum event severity to write.
   */
  constructor(private readonly level: LogLevel) {}

  /**
   * Writes a debug event when enabled by the configured threshold.
   *
   * @param event - Stable event name.
   * @param data - Optional structured event data.
   */
  debug(event: string, data?: LogData): void {
    this.write("debug", event, data);
  }

  /**
   * Writes an informational event when enabled by the configured threshold.
   *
   * @param event - Stable event name.
   * @param data - Optional structured event data.
   */
  info(event: string, data?: LogData): void {
    this.write("info", event, data);
  }

  /**
   * Writes a warning event when enabled by the configured threshold.
   *
   * @param event - Stable event name.
   * @param data - Optional structured event data.
   */
  warn(event: string, data?: LogData): void {
    this.write("warn", event, data);
  }

  /**
   * Writes an error event when enabled by the configured threshold.
   *
   * @param event - Stable event name.
   * @param data - Optional structured event data.
   */
  error(event: string, data?: LogData): void {
    this.write("error", event, data);
  }

  /** Writes an event when it passes the configured threshold. */
  private write(level: LogLevel, event: string, data?: LogData): void {
    if (levelRank[level] < levelRank[this.level]) {
      return;
    }

    const prefix = `[${new Date().toISOString()}] [${level}] ${event}`;

    if (data === undefined) {
      console.log(prefix);
      return;
    }

    console.log(prefix, data);
  }
}
