import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: resolve(__dirname, "../.env") });

export const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
export const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID ?? "";
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
