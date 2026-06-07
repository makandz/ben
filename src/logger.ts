import type { LogLevel } from "./config.js";

type LogData = Record<string, unknown>;

const levelRank: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(event: string, data?: LogData): void {
    this.write("debug", event, data);
  }

  info(event: string, data?: LogData): void {
    this.write("info", event, data);
  }

  warn(event: string, data?: LogData): void {
    this.write("warn", event, data);
  }

  error(event: string, data?: LogData): void {
    this.write("error", event, data);
  }

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
