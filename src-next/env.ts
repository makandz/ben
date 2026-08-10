export type LogLevel = "debug" | "info" | "warn" | "error";

export type AppEnv = {
  discordToken: string;
  openaiApiKey: string;
  discordLogChannelId: string | undefined;
  openaiDailyBudgetUsd: number;
  logLevel: LogLevel;
  logPrompts: boolean;
};

const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);

/**
 * Loads the replacement runtime's external configuration.
 *
 * @param source - Environment values, defaulting to the current process environment.
 * @returns Validated application configuration.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return {
    discordToken: requireValue(source, "DISCORD_TOKEN"),
    openaiApiKey: requireValue(source, "OPENAI_API_KEY"),
    discordLogChannelId: readOptionalValue(source, "DISCORD_LOG_CHANNEL_ID"),
    openaiDailyBudgetUsd: readNonNegativeNumber(source, "OPENAI_DAILY_BUDGET_USD", 0),
    logLevel: readLogLevel(source),
    logPrompts: readBoolean(source, "LOG_PROMPTS", false),
  };
}

/** Reads a required, non-empty environment value. */
function requireValue(source: NodeJS.ProcessEnv, name: string): string {
  const value = readOptionalValue(source, name);

  if (value === undefined) {
    throw new Error(`Missing ${name}. Add it to .env before starting the bot.`);
  }

  return value;
}

/** Reads an optional environment value, treating whitespace as missing. */
function readOptionalValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = source[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Reads a finite, non-negative numeric environment value. */
function readNonNegativeNumber(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = readOptionalValue(source, name);

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return parsed;
}

/** Reads the configured logging threshold. */
function readLogLevel(source: NodeJS.ProcessEnv): LogLevel {
  const value = readOptionalValue(source, "LOG_LEVEL") ?? "info";

  if (!logLevels.has(value as LogLevel)) {
    throw new Error("LOG_LEVEL must be one of: debug, info, warn, error.");
  }

  return value as LogLevel;
}

/** Reads a strict true/false environment flag. */
function readBoolean(source: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = readOptionalValue(source, name);

  if (value === undefined) {
    return fallback;
  }

  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be either true or false.`);
  }

  return value === "true";
}
