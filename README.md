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
   - Server Members Intent

5. Start the bot:

   ```sh
   pnpm dev
   ```

The bot logs when it connects. It replies in the channel where the triggering message batch was received. Status messages such as wake, wait, sleep, and reasoning summaries are sent to `DISCORD_LOG_CHANNEL_ID` when configured.

## Internal Actions

The bot can run separate scheduled internal actions using their own prompt files under `src/prompts/internal/`.

The first internal action runs once on startup and then every 24 hours by default. It asks `gpt-5.4-nano` to choose Ben's Discord activity status, then applies that status and optionally writes a log line like:

```text
> 🧠 thinking quietly
```

This is not shared reasoning or hidden chain-of-thought. The internal action prompt requires the model to return only the public status payload needed by the bot.

The last status is stored in a separate JSON file at `logs/internal-state.json` by default. If the bot restarts before 24 hours have passed, it reuses the saved status and waits until the original 24-hour window expires before asking the model again.

## Discord Commands

- `/usage` shows today's persisted OpenAI request count, input tokens, cached input tokens, output tokens, total tokens, estimated cost, and configured model.

## Configuration

- `OPENAI_MODEL` defaults to `gpt-5.4-mini`.
- `OPENAI_INTERNAL_MODEL` defaults to `gpt-5.4-nano`.
- `OPENAI_DAILY_BUDGET_USD` defaults to `0`, which disables the daily cost stop. Set it to a positive dollar amount to stop OpenAI calls after that day's stored usage reaches the limit.
- `OPENAI_USAGE_LOG_DIR` defaults to `logs/openai-usage`. Usage is stored in monthly `YYMM.json` files with daily buckets.
- `BOT_INTERNAL_STATE_PATH` defaults to `logs/internal-state.json`. Internal action state is stored separately from usage.
- `DISCORD_LOG_CHANNEL_ID` optionally enables internal action log lines, wake/wait/sleep status messages, and reasoning summaries in a dedicated Discord channel.
- `KNOWN_PEOPLE` maps Discord usernames to real names in prompts, for example `{"makandz":"Makan"}`. Known users are shown as `makandz (Makan): ...`; unknown users stay as `username: ...`.
- `LOG_LEVEL` defaults to `info`; use `debug` for queue and debounce details.
- `LOG_PROMPTS=true` logs full prompts at debug level.
- `BOT_DEBOUNCE_MS` defaults to `3000`.
- `BOT_IDLE_SLEEP_MS` defaults to `600000`.
- `BOT_MESSAGE_LINE_DELAY_MS` defaults to `1000`; multi-line bot replies are sent one line at a time with this delay before each next line.
- `BOT_INTERNAL_ACTION_INTERVAL_MS` defaults to `86400000`.

The system prompt is loaded from `src/prompts/system.txt` on each OpenAI request, so edits are picked up without restarting the bot.

## Scripts

- `pnpm dev` starts the bot with `tsx` in watch mode.
- `pnpm build` compiles TypeScript into `dist/`.
- `pnpm start` runs the compiled bot.
- `pnpm lint` runs ESLint.
