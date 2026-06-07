# Discord OpenAI Bot

TypeScript Discord bot that wakes on a ping, batches recent human messages, and responds through the OpenAI Responses API.

## Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create a local environment file:

   ```sh
   cp .env.example .env
   ```

3. Add your bot token and OpenAI API key to `.env`:

   ```sh
   DISCORD_TOKEN=your_discord_bot_token
   OPENAI_API_KEY=your_openai_api_key
   ```

4. Enable these Discord gateway intents for the bot in the Discord developer portal:

   - Message Content Intent
   - Server Members Intent is not required

5. Start the bot:

   ```sh
   pnpm dev
   ```

The bot logs when it connects. It replies in the channel where the triggering message batch was received.

## Discord Commands

- `/usage` shows today's persisted OpenAI request count, input tokens, cached input tokens, output tokens, total tokens, estimated cost, and configured model.

## Configuration

- `OPENAI_MODEL` defaults to `gpt-5.4-mini`.
- `OPENAI_DAILY_BUDGET_USD` defaults to `0`, which disables the daily cost stop. Set it to a positive dollar amount to stop OpenAI calls after that day's stored usage reaches the limit.
- `OPENAI_USAGE_LOG_DIR` defaults to `logs/openai-usage`. Usage is stored in monthly `YYMM.json` files with daily buckets.
- `LOG_LEVEL` defaults to `info`; use `debug` for queue and debounce details.
- `LOG_PROMPTS=true` logs full prompts at debug level.
- `BOT_DEBOUNCE_MS` defaults to `3000`.
- `BOT_IDLE_SLEEP_MS` defaults to `600000`.
- `BOT_MESSAGE_LINE_DELAY_MS` defaults to `1000`; multi-line bot replies are sent one line at a time with this delay before each next line.

The system prompt is loaded from `src/prompts/system.txt` on each OpenAI request, so edits are picked up without restarting the bot.

## Scripts

- `pnpm dev` starts the bot with `tsx` in watch mode.
- `pnpm build` compiles TypeScript into `dist/`.
- `pnpm start` runs the compiled bot.
- `pnpm lint` runs ESLint.
