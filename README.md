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

The bot logs when it connects. It replies in the channel where the triggering message batch was received, and can route requested messages to another server channel by name. Ben stays active in one channel at a time; pings from other channels are queued until the current channel sleeps. Status messages such as wake, wait, sleep, and reasoning summaries are sent to `DISCORD_LOG_CHANNEL_ID` when configured.

## Scheduled Messages

Ben can schedule future messages from natural Discord requests, such as:

```text
ben remind me tomorrow at 9 to check the deploy
ben every day at 6pm ask alex and priya if they're joining the call tonight
```

Scheduled messages require real target users. Ben validates usernames and channels before saving, stores resolved Discord user IDs and channel IDs, and persists schedules to JSON so they survive restarts. At send time, Ben posts the target user pings followed by the scheduled text.

Supported repeats are one-time, daily, and weekly. Monthly schedules are intentionally not supported yet. Dates and times are interpreted in Ben's `America/Toronto` timezone.

## Internal Actions

The bot can run separate scheduled internal actions using their own prompt files under `src/prompts/internal/`.

The first internal action runs once on startup and then every 24 hours by default. It asks `gpt-5.6-luna` to choose Ben's Discord activity status, then applies that status and optionally writes a log line like:

```text
> 🧠 thinking quietly
```

This is not shared reasoning or hidden chain-of-thought. The internal action prompt requires the model to return only the public status payload needed by the bot.

The last status is stored in a separate JSON file at `logs/internal-state.json` by default. If the bot restarts before 24 hours have passed, it reuses the saved status and waits until the original 24-hour window expires before asking the model again.

## Discord Commands

- `/usage` shows today's persisted OpenAI request count, input tokens, cached input tokens, output tokens, total tokens, estimated cost, and configured model.

## Configuration

- `DISCORD_TOKEN` is required.
- `OPENAI_API_KEY` is required.
- `DISCORD_LOG_CHANNEL_ID` optionally enables internal action log lines, wake/wait/sleep status messages, and reasoning summaries in a dedicated Discord channel.
- `OPENAI_DAILY_BUDGET_USD` defaults to `0`, which disables the daily cost stop. Set it to a positive dollar amount to stop OpenAI calls after that day's stored usage reaches the limit.
- `LOG_LEVEL` defaults to `info`; use `debug` for queue and debounce details.
- `LOG_PROMPTS=true` logs full prompts at debug level.

Model names, storage paths, session timings, scheduler intervals, and the scheduling timezone are local constants beside the code that owns them.

The system prompt is loaded from the local `prompts/system.txt` asset on each OpenAI request. In development, edits are picked up without restarting the bot; `pnpm build` copies both prompt assets into `dist` for production.

## Scripts

- `pnpm dev` starts the bot with `tsx` in watch mode.
- `pnpm build` compiles TypeScript into `dist/`.
- `pnpm start` runs the compiled bot.
- `pnpm typecheck` checks TypeScript without emitting files.
- `pnpm test` runs the test suite without connecting to Discord or OpenAI.
- `pnpm lint` runs ESLint.
