# Ben console

Drive the real application and tools through an entirely local Discord gateway. Nothing connects to Discord. Session state and OpenAI spending are separate from the running bot.

From the repository root:

```sh
pnpm --silent console
# Or bypass the package manager:
node --import tsx tools/ben-console/worker.ts
```

Paste one JSON object per line. Keep stdin open for adaptive follow-ups; piping a finite file closes stdin and drains the session immediately. Start explicitly before sending messages:

```jsonl
{"id":"start","op":"start"}
{"id":"hello","op":"message","user":"makan","channel":"general","content":"@Ben hey, how are you?"}
{"id":"alex","op":"message","user":"alex","channel":"general","content":"I'm Alex. I like co-op games."}
{"id":"typing","op":"typing","user":"alex","channel":"general"}
{"id":"group","op":"batch","messages":[{"user":"makan","content":"@Ben any ideas?"},{"user":"alex","content":"something cooperative"}]}
{"id":"games","op":"message","user":"alex","channel":"games","content":"@Ben what do you think?"}
{"id":"inspect","op":"inspect"}
{"id":"fresh","op":"reset"}
{"id":"stop","op":"stop"}
```

Wait for `result.status: "ready"` before sending other commands after start/reset. All request IDs must be unique for the worker's lifetime. Messages can arrive during a model request. A `batch` injects all its messages synchronously so they share the usual debounce window. Other-channel pings queue behind the active conversation. Follow-ups in the active channel need no ping until Ben sleeps. Sleeping context is bounded exactly as in production.

The `ready` event and start/reset result include absolute `logPath` and `tracePath`. In another app terminal, watch the readable log:

```sh
tail -f /absolute/path/from/ready/session.log
```

`session.log` has readable messages, prompt context and tool results. `trace.jsonl` holds full ordered model instructions, histories, outputs, calls, exact tool results, session transitions, deliveries and serialized errors. Both use the same sequence numbers. `inspect` returns the exact last terminal outcome, local transcripts, pending request IDs, current session mode, disk state, spending and events. Inspection during processing is a point-in-time view, not a transaction across files.

## Protocol

Input is newline-delimited UTF-8 JSON; CRLF and fragmented stream writes are supported. Blank lines are ignored. stdout contains JSON only when launched directly or through `pnpm --silent`; stderr is reserved for worker diagnostics. The worker emits events as they occur, independent of command responses. There is no interactive shell or polished UI.

Every command has a non-empty string `id` and an `op`; unknown fields and invalid values are rejected with `{ "type": "error", "requestId": ..., "error": ... }`. Invalid JSON has a null request ID.

| op        | Additional fields                                                                                         | Response                                                          |
| --------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `start`   | Optional settings below                                                                                   | `ack`, session `ready`, then `result` with paths                  |
| `message` | Required `content`; optional `user`, `channel`, `ping`, `replyTo`                                         | `ack`, input events, `injected` with message IDs; later `settled` |
| `batch`   | `messages`: 1-100 message field objects                                                                   | Same as message; terminal outcomes accumulate across channels     |
| `typing`  | Optional `user`, `channel`                                                                                | Input event and `ack`                                             |
| `fail`    | `operation`: `send`, `reaction`, `typing`, `presence`, or `status`; optional positive `count` (default 1) | `ack`; the next selected operations fail                          |
| `inspect` | None                                                                                                      | `ack`, `result.state`                                             |
| `reset`   | None                                                                                                      | `ack`, drained old session, new `ready`, `result`                 |
| `stop`    | None                                                                                                      | `ack`, drained session, `result.status: "stopped"`                |

`ack` means accepted, never that a conversation completed. `settled` has `requestId` and `status`:

- `complete`: all injected message IDs were observed in applied terminal outcomes, with the last outcome and accumulated `outcomes` attached. This can mean sleep, including a turn without visible text.
- `wait`: all inputs reached terminal outcomes and the last outcome retains conversation context.
- `failed`: all inputs reached outcomes and the last outcome failed. Inspect exact tool results and delivery events too; a successful turn may still contain a delivery failure.
- `no-wake`: all inputs arrived while sleeping without any Ben mention, so they only added context.
- `timeout`: the observation bound expired. Work may still be queued or processing; later raw events remain available. It does not cancel work or prove failure.
- `stopped`: shutdown discarded an input not observed in a terminal outcome.

Raw `turn_completed` and `session_sleep` events describe application turns, not request completion. Sleep can promote another channel before the previous `turn_completed` event. A visible Discord message is never used as proof of completion. A multi-channel batch containing context-only messages can time out if those channels never wake.

Defaults: users `makan`, `alex`; channels `general`, `games`, `ben-log`. `user` and `channel` accept names or the stable IDs shown in `ready`, and default to the first configured entry. `@Ben` and `ping: true` wake Ben; other configured `@username` and `#channel` mentions use the normal Discord directories. Model-authored reply references and mentions go through the real transport. Input `replyTo` prefixes a readable reference in content because the application's input boundary has no native reply metadata.

Start settings:

```json
{
  "id": "custom",
  "op": "start",
  "users": ["makan", "alex"],
  "channels": ["general", "games", "ben-log"],
  "dailyBudgetUsd": 1,
  "timeoutMs": 60000,
  "timings": {
    "messageDebounceMs": 100,
    "typingDebounceMs": 1000,
    "idleSleepMs": 300000,
    "typingRefreshMs": 8000
  },
  "seed": {
    "memories.json": { "version": 1, "memories": ["Alex enjoys cooperative games."] },
    "known-people.json": { "people": { "1001": { "username": "alex", "name": "Alex" } } },
    "long-term-memory.txt": "Friends enjoy game nights."
  }
}
```

`dailyBudgetUsd` is finite and nonnegative, default $1. As in the existing usage store, zero disables the daily limit. The limit checks before requests and can overshoot by the last request's cost. Usage is isolated per session and resets with each new session, so it is not an aggregate cap across resets. The default real model is Ben's configured `gpt-6-luna`, high reasoning, 512 output tokens. `OPENAI_API_KEY` comes from the process environment or repo `.env`; no Discord credential is required or read by the gateway. Credentials are not saved in config snapshots and are scrubbed from diagnostic strings.

`timeoutMs` defaults to 30,000 and is between 1 and 3,600,000. Debounce timings accept 0-60,000 ms; idle accepts 1-3,600,000 ms; typing refresh accepts 1-60,000 ms. Console defaults use a 100 ms message debounce and 1 second typing debounce, with production idle and typing refresh intervals. Time remains real wall time.

`seed` accepts only application filenames: `conversation-summaries.json`, `known-people.json`, `tasks.json`, `custom-status.json`, `memories.json`, and `long-term-memory.txt`. JSON seeds use existing store schemas; text seeds are strings. Persisted tasks are inspectable and editable through real tools, but background task and memory consolidation schedulers are disabled to avoid unsolicited startup API requests. Startup still exercises ready, status and command registration.

Artifacts default to ignored `.ben-console/session-*` directories. Set `BEN_CONSOLE_ROOT` to choose another artifact root. The root is canonicalized and rejected if it overlaps live `logs`, including through symlinks. Reset always creates a fresh directory and preserves the old one. Prompts and model config are snapshotted at creation. Reset and shutdown await in-flight turns and their persistence before closing artifacts; they do not cancel an OpenAI request and can take as long as that request. Inputs are rejected during start/reset/stop. `stop` exits the terminal worker after draining; EOF and SIGINT/SIGTERM also drain safely.

Simulation covers local directory lookups, delivery, reaction, typing, presence and custom status. It does not reproduce Discord permissions, rate limits, attachments, network latency or native reply notifications. Nothing modifies live logs or prompt files, and no second bot instance is started.

Tests inject `ScriptedModel` through `startSession`/`createWorker` rather than a protocol model override. They never make live model requests. Run `pnpm test`, `pnpm typecheck` and `pnpm lint` for normal checks; `pnpm typecheck:tools` checks the harness alone with its source dependencies.
