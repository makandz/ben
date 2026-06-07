export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  discordToken: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiDailyBudgetUsd: number;
  openaiUsageLogDir: string;
  logLevel: LogLevel;
  logPrompts: boolean;
  debounceMs: number;
  idleSleepMs: number;
  messageLineDelayMs: number;
}

const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name}. Add it to .env before starting the bot.`);
  }

  return value;
}

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return parsed;
}

function readLogLevel(): LogLevel {
  const value = process.env.LOG_LEVEL ?? "info";

  if (!logLevels.has(value as LogLevel)) {
    throw new Error("LOG_LEVEL must be one of: debug, info, warn, error.");
  }

  return value as LogLevel;
}

export function loadConfig(): AppConfig {
  return {
    discordToken: requireEnv("DISCORD_TOKEN"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    openaiDailyBudgetUsd: readNumberEnv("OPENAI_DAILY_BUDGET_USD", 0),
    openaiUsageLogDir: process.env.OPENAI_USAGE_LOG_DIR ?? "logs/openai-usage",
    logLevel: readLogLevel(),
    logPrompts: process.env.LOG_PROMPTS === "true",
    debounceMs: readNumberEnv("BOT_DEBOUNCE_MS", 3_000),
    idleSleepMs: readNumberEnv("BOT_IDLE_SLEEP_MS", 10 * 60 * 1_000),
    messageLineDelayMs: readNumberEnv("BOT_MESSAGE_LINE_DELAY_MS", 1_000),
  };
}
