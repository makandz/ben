# Ben

Ben is an AI member of a private Discord server.

Ping him and he joins the conversation, catches up on what people were saying, waits for everyone to finish typing, and responds in the same casual rhythm as the rest of the server. He is designed to feel present without needing to be the center of attention.

## What Ben does

- holds multi-person conversations with recent channel context;
- waits for a natural pause before responding;
- replies to and reacts to Discord messages;
- consolidates recent conversations and short-term memories into long-term memory;
- remembers people's preferred names;
- sets his own custom status;
- schedules one-time, daily, or weekly messages; and
- reports OpenAI usage through `/usage`.

Ben stays active in one channel at a time. Other pings are queued until he is free, and a small amount of conversation context is saved when he goes back to sleep.

## Setup

Requires Node.js 20+, pnpm, a Discord bot token, and an OpenAI API key.

```sh
pnpm install
cp .env.example .env
```

Add your credentials to `.env`:

```dotenv
DISCORD_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key
```

Enable **Message Content Intent** and **Server Members Intent** for the bot in the Discord developer portal, then run:

```sh
pnpm dev
```

## Configuration

| Variable                  | Default | Purpose                                                   |
| ------------------------- | ------- | --------------------------------------------------------- |
| `DISCORD_LOG_CHANNEL_ID`  | unset   | Sends lifecycle and scheduling logs to a Discord channel. |
| `OPENAI_DAILY_BUDGET_USD` | `0`     | Stops model calls at a daily cost limit. `0` disables it. |
| `LOG_LEVEL`               | `info`  | Sets the console log level.                               |

Scheduled messages use the `America/Toronto` timezone. Runtime state is stored under the gitignored `logs/` directory. Ben checks for memory consolidation every 24 hours, skips the model call when there is no short-term context, and stores the resulting long-term memory as plain text.

## Development

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Ben's personality and behavior are defined in [`src/prompts/system.txt`](src/prompts/system.txt). In development, prompt edits take effect on the next model request without a restart.
