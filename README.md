# Discord Hello Bot

Minimal TypeScript Discord bot that connects to Discord and says hello.

## Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create a local environment file:

   ```sh
   cp .env.example .env
   ```

3. Add your bot token to `.env`:

   ```sh
   DISCORD_TOKEN=your_discord_bot_token
   ```

4. Start the bot:

   ```sh
   pnpm dev
   ```

The bot logs a hello message when it connects. To also send `Hello!` to a server text channel on startup, set `DISCORD_CHANNEL_ID` in `.env`.

## Scripts

- `pnpm dev` starts the bot with `tsx` in watch mode.
- `pnpm build` compiles TypeScript into `dist/`.
- `pnpm start` runs the compiled bot.
- `pnpm lint` runs ESLint.
