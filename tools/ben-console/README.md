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

## Conversation evaluation

`npm run console:eval` runs the eight scenarios in
[`scenarios/baseline.json`](scenarios/baseline.json). Each scenario defines acceptance
criteria before execution, uses stable synthetic speaker IDs, and starts from fresh
state for every repetition. No Discord connection is made. The real model uses the
existing API key from the environment or `.env`; injected models are used only in
tests. Default spending limit is $1 per isolated session, not per batch. Running all
eight once therefore allows up to $8. Change `dailyBudgetUsd` in a copied suite to
set another per-session bound.

```sh
# Full baseline, one repetition per scenario.
npm run console:eval -- run

# Repeat important cases and related cases in fresh sessions.
npm run console:eval -- run --scenario names --scenario memory-attribution --repeat 3

# Try candidate instructions independently of production prompt files.
npm run console:eval -- run --scenario names --scenario memory-attribution --repeat 3 \
  --messaging-prompt /absolute/path/candidate-messaging.md
# Also supported: --base-prompt /absolute/path/candidate-base.md
```

`--suite FILE` selects another validated JSON suite. `--root DIRECTORY` changes
artifact storage; default `.ben-console/evaluations` is ignored by Git. The command
prints the batch directory followed by each scenario repetition directory. Open
`index.md` for batch links, then each run's `report.md`. SIGINT/SIGTERM stops further
steps/repetitions and drains active work before saving final state. An observation
timeout also stops further steps and drains; it does not cancel an API call. The
packet stays incomplete even if a late turn succeeds during drain. API calls may
therefore outlive the scenario's observation timeout.

Each run saves:

- `packet.json`: exact scenario, criteria, repetition, observation status, step
  ranges in the trace and state snapshot links.
- `starting-state.json`, `step-N.json`, `final-state.json`: full messages and
  persisted state at those boundaries. Final state is captured after drain.
- `session-*/config.json` and `prompts.json`: effective model settings, seed,
  timings and complete instructions. Candidate texts are snapshotted here and do
  not modify `src/prompts` or the running bot.
- `session-*/trace.jsonl` and `session.log`: ordered actual model/tool requests,
  results, failures, delivery, scheduler diagnostics and lifecycle events.
- `review-template.json`: an intentionally ungraded starting template.

The runner does **not** judge prose using keywords or call a hosted grader.
Codex or a human reads the conversation together with tool results and state, then
copies `review-template.json` to `review.json`. Fill `reviewer`, and retain only
criteria actually assessed. Each assessment requires `pass`, `fail` or
`inconclusive`, concise reasoning, and actual trace sequence IDs in `evidence`.
Template null statuses are rejected. Missing criteria remain pending. For issues,
optionally set `issueSource` to `prompt`, `runtime`, `tool` or `simulation`; this is
the reviewer's likely attribution, not a diagnosis inferred by the runner.

Example saved assessment (substitute the actual run ID and trace sequences):

```json
{
  "version": 1,
  "runId": "names-1-abc123",
  "reviewer": "Codex with Makan",
  "assessments": [
    {
      "criterionId": "name-attribution",
      "status": "pass",
      "reasoning": "The follow-up uses Makan's supplied name and preserves Alex's separate identity.",
      "evidence": [12, 19, 23]
    }
  ]
}
```

```sh
# Validate a saved review and regenerate its report.
npm run console:eval -- report /absolute/path/baseline/names-1-abc123

# Compare the same scenario and repetition from two batches.
npm run console:eval -- compare /absolute/path/baseline/names-1-abc123 \
  /absolute/path/candidate/names-1-def456 --output /absolute/path/comparison.md
```

Comparisons require identical scenario definitions, criteria, repetition, seed,
settings, timezone and effective model config. Prompt overrides may differ.
Unmatched cases must be run before comparing them; missing reviews or criteria
stay unassessed, and incomplete or inconclusive cases cannot establish improvement.
Read reasons and cited traces in both reports, repeat important cases and examine
related scenarios before adopting a prompt refinement. A scenario completing its
steps is only an observation status, never a semantic pass.

The small scenario step vocabulary is `messages` (one message or a batch), `fail`
(local Discord delivery operation and count), `inspect`, `wait` (bounded real
milliseconds), and `wait-turns` (total completed turns since session start, with a
bounded timeout). Unaddressed `messages` while sleeping naturally settles
`no-wake`; while awake it may trigger participation, which is reviewed in the group
scenario. There is no arbitrary script DSL or virtual clock.

Background schedulers remain off by default. `settings.taskScheduler: true` opts
only the isolated task scheduler in, leaving memory consolidation off. The
scheduled-task case seeds a compatible overdue one-time task, waits for its real
wake/turn and inspects durable completion. Other task cases use tomorrow in
America/Toronto and keep scheduling disabled so creation/edit/deletion can be
reviewed independently. Live Ben and shared `logs/` state remain untouched.
