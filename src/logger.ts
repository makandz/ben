import pino from "pino";
import type { LogLevel } from "./env.js";

export type LogData = Record<string, unknown>;
export type LoggerOptions = {
  format?: "dev" | "json";
  color?: boolean;
  destination?: { write(line: string): void };
};

type DevRecord = {
  time: number;
  level: number;
  event: string;
  msg: string;
  error?: unknown;
};

const componentColors: Record<string, number> = {
  session: 36,
  chat: 32,
  tasks: 35,
  memory: 34,
  memories: 34,
  people: 90,
  discord: 37,
  typing: 90,
  model: 34,
  openai: 34,
};

/** Writes structured application events and an optional readable development feed. */
export class Logger {
  private readonly logger: pino.Logger;

  /**
   * Creates a logger. Development output follows NODE_ENV; all other environments use JSON.
   *
   * @param level - Minimum event severity to write; debug also includes dev error stacks.
   * @param options - Output format, terminal coloring, and optional destination overrides.
   */
  constructor(level: LogLevel, options: LoggerOptions = {}) {
    const format = options.format ?? (process.env.NODE_ENV === "development" ? "dev" : "json");
    const destination = options.destination ?? process.stdout;
    const color = options.color ?? (process.stdout.isTTY && process.env.NO_COLOR === undefined);
    this.logger = pino(
      { level, base: null, serializers: { error: pino.stdSerializers.errWithCause } },
      format === "json"
        ? destination
        : {
            write(line: string) {
              destination.write(formatDev(JSON.parse(line) as DevRecord, color, level === "debug"));
            },
          },
    );
  }

  /**
   * Writes a debug event when enabled by the configured threshold.
   * @param event - Stable event name.
   * @param data - Optional structured event data.
   * @param message - Readable activity sentence, falling back to the event name.
   */
  debug(event: string, data?: LogData, message?: string): void {
    this.logger.debug({ ...data, event }, message ?? event);
  }

  /**
   * Writes an informational event when enabled by the configured threshold.
   * @param event - Stable event name.
   * @param data - Optional structured event data.
   * @param message - Readable activity sentence, falling back to the event name.
   */
  info(event: string, data?: LogData, message?: string): void {
    this.logger.info({ ...data, event }, message ?? event);
  }

  /**
   * Writes a warning event when enabled by the configured threshold.
   * @param event - Stable event name.
   * @param data - Optional structured event data, retaining actual errors for serialization.
   * @param message - Readable activity sentence, falling back to the event name.
   */
  warn(event: string, data?: LogData, message?: string): void {
    this.logger.warn({ ...data, event }, message ?? event);
  }

  /**
   * Writes an error event when enabled by the configured threshold.
   * @param event - Stable event name.
   * @param data - Optional structured event data, retaining actual errors for serialization.
   * @param message - Readable activity sentence, falling back to the event name.
   */
  error(event: string, data?: LogData, message?: string): void {
    this.logger.error({ ...data, event }, message ?? event);
  }
}

/** Formats layout and errors without interpreting application event semantics. */
function formatDev(record: DevRecord, color: boolean, stacks: boolean): string {
  const time = new Date(record.time).toLocaleTimeString("en-GB", { hour12: false });
  const component = record.event.split(".")[0] ?? "app";
  const labels: Record<string, string> = {
    conversation: "chat",
    conversation_summaries: "memory",
    memory_consolidation: "memory",
    long_term_memory: "memory",
    known_people: "people",
    custom_status: "discord",
  };
  const label =
    record.level >= 50
      ? "ERROR"
      : record.level >= 40
        ? "WARN"
        : (labels[component] ?? component.slice(0, 8));
  const error = record.error;
  const errorObject =
    error !== null && typeof error === "object"
      ? (error as { message?: unknown; stack?: unknown })
      : undefined;
  const errorMessage =
    error === undefined
      ? undefined
      : typeof errorObject?.message === "string"
        ? errorObject.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
  const message = singleLine(record.msg + (errorMessage === undefined ? "" : `: ${errorMessage}`));
  const alignedLabel = singleLine(label).padEnd(8);
  const tint = record.level >= 50 ? 31 : record.level >= 40 ? 33 : (componentColors[label] ?? 90);
  const prefix = color
    ? `\u001b[2m${time}\u001b[0m  \u001b[${String(tint)}m${alignedLabel}\u001b[0m`
    : `${time}  ${alignedLabel}`;
  const stack = typeof errorObject?.stack === "string" ? errorObject.stack : undefined;
  return `${prefix}  ${message}\n${stacks && stack !== undefined ? `${stack}\n` : ""}`;
}

/** Escapes embedded line separators and terminal control characters in routine feed lines. */
function singleLine(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 31 && code !== 127 && code !== 0x2028 && code !== 0x2029) escaped += character;
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else escaped += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return escaped;
}
