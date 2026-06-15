export type LogLevel = "debug" | "info" | "warn" | "error";

export interface KnownPerson {
  name: string;
}

export interface AppConfig {
  discordToken: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiInternalModel: string;
  openaiDailyBudgetUsd: number;
  openaiUsageLogDir: string;
  internalStatePath: string;
  conversationSummaryPath: string;
  discordLogChannelId: string | undefined;
  knownPeople: Record<string, KnownPerson>;
  logLevel: LogLevel;
  logPrompts: boolean;
  messageDebounceMs: number;
  typingDebounceMs: number;
  idleSleepMs: number;
  messageLineDelayMs: number;
  internalActionIntervalMs: number;
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

function readKnownPeople(): Record<string, KnownPerson> {
  const value = process.env.KNOWN_PEOPLE;

  if (!value) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'KNOWN_PEOPLE must be valid JSON, like {"makandz":"Makan"}.',
    );
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(
      "KNOWN_PEOPLE must be a JSON object mapping Discord usernames to names.",
    );
  }

  const knownPeople: Record<string, KnownPerson> = {};

  for (const [username, value] of Object.entries(parsed)) {
    const normalizedUsername = username.trim().toLowerCase();

    if (normalizedUsername.length === 0) {
      throw new Error("KNOWN_PEOPLE must use non-empty Discord usernames.");
    }

    if (typeof value === "string") {
      const name = value.trim();

      if (name.length === 0) {
        throw new Error(
          "KNOWN_PEOPLE string entries must use non-empty names.",
        );
      }

      knownPeople[normalizedUsername] = { name };
      continue;
    }

    if (typeof value !== "string") {
      throw new Error("KNOWN_PEOPLE must map Discord usernames to names.");
    }

    const name = value.trim();

    if (name.length === 0) {
      throw new Error(
        "KNOWN_PEOPLE must map non-empty Discord usernames to non-empty names.",
      );
    }

    knownPeople[normalizedUsername] = { name };
  }

  return knownPeople;
}

export function loadConfig(): AppConfig {
  return {
    discordToken: requireEnv("DISCORD_TOKEN"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    openaiInternalModel: process.env.OPENAI_INTERNAL_MODEL ?? "gpt-5.4-nano",
    openaiDailyBudgetUsd: readNumberEnv("OPENAI_DAILY_BUDGET_USD", 0),
    openaiUsageLogDir: process.env.OPENAI_USAGE_LOG_DIR ?? "logs/openai-usage",
    internalStatePath:
      process.env.BOT_INTERNAL_STATE_PATH ?? "logs/internal-state.json",
    conversationSummaryPath:
      process.env.BOT_CONVERSATION_SUMMARY_PATH ?? "logs/conversation-summaries.json",
    discordLogChannelId: process.env.DISCORD_LOG_CHANNEL_ID,
    knownPeople: readKnownPeople(),
    logLevel: readLogLevel(),
    logPrompts: process.env.LOG_PROMPTS === "true",
    messageDebounceMs: readNumberEnv("BOT_MESSAGE_DEBOUNCE_MS", 5_000),
    typingDebounceMs: readNumberEnv("BOT_TYPING_DEBOUNCE_MS", 10_000),
    idleSleepMs: readNumberEnv("BOT_IDLE_SLEEP_MS", 10 * 60 * 1_000),
    messageLineDelayMs: readNumberEnv("BOT_MESSAGE_LINE_DELAY_MS", 1_000),
    internalActionIntervalMs: readNumberEnv(
      "BOT_INTERNAL_ACTION_INTERVAL_MS",
      24 * 60 * 60 * 1_000,
    ),
  };
}
