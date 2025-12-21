import "dotenv/config";

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  channelId: process.env.CHANNEL_ID,
  geminiApiKey: process.env.GEMINI_API_KEY,
};

// Validate required env vars at startup
const required = ["DISCORD_TOKEN", "CHANNEL_ID", "GEMINI_API_KEY"] as const;
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}
