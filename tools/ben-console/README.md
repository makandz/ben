# Ben console

Run Ben's real application and tools through a local Discord gateway with separate state and OpenAI usage. From the repository root:

```sh
pnpm --silent console
# Or: node --import tsx tools/ben-console/worker.ts
```

Paste one JSON object per line. Start explicitly and wait for `result.status: "ready"` before sending messages. Keep stdin open for follow-ups; EOF drains the session immediately.

```jsonl
{"op":"start"}
{"op":"message","user":"makan","content":"@Ben hey, how are you?"}
{"op":"batch","messages":[{"user":"makan","content":"@Ben any game ideas?"},{"user":"alex","content":"something cooperative"}]}
{"op":"message","user":"alex","channel":"games","content":"@Ben what do you think?"}
{"op":"inspect"}
{"op":"stop"}
```

Commands are `start`, `message`, `batch`, `inspect` and `stop`. Unknown fields and invalid values produce an `error` event. A command `result` describes startup, injected message IDs, an inspection snapshot or shutdown. Raw model, tool and lifecycle events describe what Ben actually did; there is no per-message completion tracking. Messages can arrive while a model request is running. A batch injects 1-100 messages synchronously into the normal debounce window. Pings in another channel queue behind the current conversation.

Defaults are users `makan`, `alex` and channels `general`, `games`, `ben-log`. Messages require `content`; optional `user` and `channel` accept names or IDs from `ready` and default to the first configured entry. `@Ben` or `ping: true` wakes Ben. Follow-ups in the active channel need no ping until Ben sleeps. Configured `@username` and `#channel` mentions use the real application directories. Model-authored mentions and replies use the real transport.

`ready` and the start result give absolute artifact paths. Watch the readable log in another terminal:

```sh
tail -f /absolute/path/from/ready/session.log
```

`session.log` includes messages, prompt context and tool results. `trace.jsonl` contains full ordered model instructions, histories, outputs, calls, tool results, lifecycle events, deliveries and errors. Both use the same sequence numbers. `inspect` returns local messages, directory entries, persisted state, usage and artifact paths. Persistence reflects completed writes; the trace shows in-flight work.

Customize the directory, daily budget or seed state on start:

```json
{
  "op": "start",
  "users": ["makan", "alex"],
  "channels": ["general", "games", "ben-log"],
  "dailyBudgetUsd": 1,
  "seed": {
    "memories.json": { "version": 1, "memories": ["Alex enjoys cooperative games."] },
    "long-term-memory.txt": "Friends enjoy game nights."
  }
}
```

Seeds accept only `conversation-summaries.json`, `known-people.json`, `tasks.json`, `custom-status.json`, `memories.json` and `long-term-memory.txt`. Use existing store schemas for JSON seeds. Background task and memory consolidation schedulers are disabled. Tasks remain inspectable and editable through the real tools.

`OPENAI_API_KEY` comes from the environment or repo `.env`. The model uses Ben's configured conversation model, high reasoning and 512 output tokens. The daily budget defaults to $1; zero disables the limit. Limits check before requests and can overshoot by the final request's cost. Usage is per session, so this is not an aggregate spending cap across process restarts. Config snapshots omit credentials and diagnostic strings scrub the API key.

Each process creates a fresh ignored `.ben-console/session-*` directory with prompt/config snapshots and isolated state. Set `BEN_CONSOLE_ROOT` for another artifact root. Roots overlapping live `logs`, including through symlinks, are rejected. Restart the console process for a fresh session; existing artifacts remain available. Stop, EOF and SIGINT/SIGTERM await in-flight work and persistence before closing artifacts. They do not cancel model requests, so shutdown may take as long as the request. Commands are rejected during setup and shutdown.

The gateway simulates directory lookups, messages, reactions, typing and presence. It does not reproduce Discord permissions, rate limits, attachments, network latency or native reply notifications. Nothing connects to Discord or changes live state or prompts.

Offline tests inject `ScriptedModel` through the session/worker API. Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Use the [conversation test template](test-template.md) to record conversations and observations we define together.
