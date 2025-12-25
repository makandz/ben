import "dotenv/config";

const getEnvVar = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

export const config = {
  discordToken: getEnvVar("DISCORD_TOKEN"),
  googleApiKey: getEnvVar("GOOGLE_API_KEY"),
  targetChannelId: getEnvVar("TARGET_CHANNEL_ID"),
  maxHistorySize: parseInt(getEnvVar("MAX_HISTORY_SIZE"), 10),
  debug: getEnvVar("DEBUG") === "true",
};
