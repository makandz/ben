import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_SQLITE_DATABASE_PATH = resolve(process.cwd(), "data", "ben.sqlite3");
const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type Config = {
  discordBotToken: string;
  discordChannelId: string;
  sqliteDatabasePath: string;
  openAiModel: string;
  openAiReasoningEffort: ReasoningEffort;
  openAiMaxTokens?: number;
};

/**
 * Loads `.env` from the current working directory when the runtime supports it.
 *
 * @param cwd - Working directory to search for a `.env` file.
 * @returns Nothing.
 */
export function loadEnvironmentFile(cwd = process.cwd()): void {
  const envPath = resolve(cwd, ".env");

  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
}

/**
 * Reads and validates application configuration from process environment variables.
 *
 * @param env - Environment variables to validate and read from.
 * @returns Parsed application configuration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const discordBotToken = requireEnv("DISCORD_BOT_TOKEN", env);
  const discordChannelId = requireEnv("DISCORD_CHANNEL_ID", env);
  const sqliteDatabasePath = parseDatabasePath(env.SQLITE_DATABASE_PATH);
  const openAiModel = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const openAiMaxTokens = parseOptionalPositiveInt(
    "OPENAI_MAX_TOKENS",
    env.OPENAI_MAX_TOKENS,
  );
  const requestedReasoningEffort = parseReasoningEffort(
    env.OPENAI_REASONING_EFFORT?.trim() || "none",
  );
  const openAiReasoningEffort = normalizeReasoningEffort(
    openAiModel,
    requestedReasoningEffort,
  );

  return {
    discordBotToken,
    discordChannelId,
    sqliteDatabasePath,
    openAiModel,
    openAiReasoningEffort,
    openAiMaxTokens,
  };
}

/**
 * Returns a non-empty environment variable value or throws a descriptive error.
 *
 * @param name - Environment variable name.
 * @param env - Environment object containing the variable.
 * @returns Trimmed environment variable value.
 */
function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/**
 * Validates the configured reasoning effort against the supported API values.
 *
 * @param value - Raw reasoning effort value from configuration.
 * @returns Validated reasoning effort.
 */
function parseReasoningEffort(value: string): ReasoningEffort {
  if (!SUPPORTED_REASONING_EFFORTS.has(value as ReasoningEffort)) {
    throw new Error(
      `OPENAI_REASONING_EFFORT must be one of: ${Array.from(SUPPORTED_REASONING_EFFORTS).join(", ")}`,
    );
  }

  return value as ReasoningEffort;
}

/**
 * Parses a positive integer environment variable when it is present.
 *
 * @param name - Environment variable name for error messages.
 * @param rawValue - Raw string value to parse.
 * @returns Parsed integer when present, otherwise `undefined`.
 */
function parseOptionalPositiveInt(
  name: string,
  rawValue: string | undefined,
): number | undefined {
  const value = rawValue?.trim();

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

/**
 * Resolves the SQLite database path from configuration.
 *
 * @param rawValue - Optional override read from the environment.
 * @returns Absolute filesystem path for the SQLite database file.
 */
function parseDatabasePath(rawValue: string | undefined): string {
  const value = rawValue?.trim();

  if (!value) {
    return DEFAULT_SQLITE_DATABASE_PATH;
  }

  return resolve(value);
}

/**
 * Normalizes unsupported model/setting combinations before the agent is created.
 *
 * @param model - Configured model name.
 * @param effort - Requested reasoning effort.
 * @returns Supported reasoning effort for the selected model.
 */
function normalizeReasoningEffort(
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (model === "gpt-5.4-mini" && effort === "minimal") {
    console.warn(
      "OPENAI_REASONING_EFFORT=minimal is not supported for gpt-5.4-mini; using none instead.",
    );
    return "none";
  }

  return effort;
}
