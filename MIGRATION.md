# Ben Architecture Migration

This is the living plan for replacing `src` with a simpler, tested implementation built in
`src-next`. The current bot remains the production reference until the replacement reaches accepted
feature parity and is deliberately cut over.

## Status

- Current phase: Phase 3 — completed; Phase 4 not started
- Production implementation: `src`
- Replacement implementation: `src-next` (Phases 1–3 only)
- Strategy: parallel replacement, then one cutover

Update this file with migration work. Keep one phase active at a time and record decisions that
change the plan.

## Goals

- Preserve Ben's current Discord behavior and persisted data.
- Keep application logic independent of `discord.js` and model-provider SDKs.
- Add a model provider without duplicating conversation orchestration.
- Add a tool without changing model adapters or a central dispatch switch.
- Test the stateful behavior that is difficult to verify manually.
- Reduce environment configuration and oversized mixed-responsibility files.
- Keep the architecture appropriate for a private friends' Discord bot.

## Non-goals

- Supporting non-Discord chat platforms.
- Runtime plugin discovery, dependency injection, domain events, or command buses.
- Repository interfaces for every JSON file.
- Abstracting every timer, filesystem call, configuration value, or identifier.
- Normalizing every feature offered by every model provider.
- Redesigning Ben's personality or behavior during the migration.
- Reaching an arbitrary test-coverage percentage.
- Keeping both source trees permanently.

## Working rules

1. `src-next` may use `src` as a reference but must never import from it.
2. The existing entry point and running server remain unchanged until cutover.
3. Never run both bots with the same Discord token or writable state files.
4. Application-owned types must not expose Discord or provider SDK types.
5. Provider translation stays inside its provider adapter.
6. Discord SDK behavior stays inside the Discord adapter and Discord-specific tools.
7. Each completed phase must type-check and its meaningful behavior must be tested.
8. Stable behavior values are named constants beside their owners.
9. Add abstractions only at real boundaries or useful test seams.
10. Preserve behavior first; make intentional behavior changes separately and document them.

## Configuration

### Environment contract

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Required | Discord credential |
| `OPENAI_API_KEY` | Required for OpenAI | Provider credential |
| `DISCORD_LOG_CHANNEL_ID` | Optional | Deployment-specific log destination |
| `OPENAI_DAILY_BUDGET_USD` | Optional, default `0` | Cost safety limit |
| `LOG_LEVEL` | Optional, default `info` | Runtime diagnostics |
| `LOG_PROMPTS` | Optional, default `false` | Explicit prompt logging switch |

A future provider adds only its credential and, when useful, a provider-selection value.

### Local constants

- Model names live in their model/internal-action modules.
- Message, typing, and idle timings live with `BotSession`.
- Tool iteration and output limits live with the orchestrator or provider adapter that uses them.
- Schedule interval and timezone live with scheduling.
- Internal action interval lives with its scheduler.
- Storage paths live where the stores are composed.
- Tests may use narrow timing overrides; these are not deployment configuration.

## Architecture

```text
Discord event
    -> DiscordAdapter
    -> BotSession
    -> ConversationOrchestrator
         -> Model -> OpenAIModel / AnthropicModel / other adapter
         -> ToolRegistry -> controls and capability tools
    -> conversation outcome
    -> BotSession
    -> ChatTransport
    -> DiscordTransport
```

Scheduled messages and internal actions are separate entry points. They may reuse model, transport,
Discord, and storage capabilities without being forced through a live conversation.

### `BotSession`

Owns wake/sleep state, the active channel, queued wakes, message batching, typing activity, idle
timing, and application of conversation outcomes. It does not translate provider data or call the
Discord SDK.

### `ConversationOrchestrator`

Builds a logical model turn, owns the multi-step tool loop, executes registered tools, retains
provider-neutral conversation history, enforces iteration limits, and returns reply/react/wait/sleep
outcomes. It does not send Discord messages.

### `Model`

Represents one provider-neutral model interaction. A provider adapter translates application items
and tool definitions, performs one provider request, and translates the result back. It may retain
opaque provider continuation data, but SDK types cannot leave the adapter. It does not know Ben's
individual tools or conversation lifecycle.

### `Tool`

A tool owns its definition, argument validation, and execution. A tool returns either:

- Continue with a model-readable result.
- Finish with a model-readable result and a terminal conversation action.

Conversation controls—reply, react, wait, and sleep—finish a turn. Capability tools—remembering a
person, cross-channel sending, scheduling, search, and future actions—normally continue it.
`ToolRegistry` remains a small name-to-tool map.

### `ChatTransport`

Exposes message sending, reactions, typing, and status output. Presence may join it or use one small
separate capability. The application may understand channels and reactions; the goal is SDK
isolation, not fake support for hypothetical chat platforms.

### Persistence

JSON stores remain concrete. A consumer may declare a small structural type for only the operations
it uses. Do not build a repository hierarchy for symmetry.

## Target layout

The layout can change when implementation reveals a clearer ownership boundary.

```text
src-next/
  index.ts
  env.ts
  logger.ts

  app/
    BotSession.ts
    BotSession.test.ts
    ConversationOrchestrator.ts
    ConversationOrchestrator.test.ts
    types.ts

  model/
    Model.ts
    openai/
      OpenAIModel.ts
      OpenAIMapper.ts
      OpenAIUsageStore.ts
      *.test.ts

  tools/
    Tool.ts
    ToolRegistry.ts
    conversationControls.ts
    *.test.ts

  discord/
    DiscordAdapter.ts
    DiscordTransport.ts
    DiscordDirectory.ts
    mentions.ts
    tools/
      rememberPerson.ts
      sendChannelMessage.ts
      createScheduledMessage.ts

  storage/
    ConversationSummaryStore.ts
    KnownPeopleStore.ts
    ScheduledMessageStore.ts

  scheduling/
    scheduleTime.ts
    ScheduledMessageScheduler.ts

  internal/
    InternalActionRunner.ts
    InternalActionScheduler.ts
    InternalStateStore.ts

  prompts/
  testing/
    ScriptedModel.ts
    RecordingTransport.ts
    createMessage.ts
```

Tests are co-located unless a reusable fake belongs in `testing`.

## Size and responsibility guardrails

These are review signals, not hard limits:

| Module | Reconsider responsibilities around |
| --- | ---: |
| `index.ts` | 120 lines |
| Environment loader | 80 lines |
| Session state machine | 400 lines |
| Conversation orchestrator | 300 lines |
| Provider adapter or mapper | 300 lines |
| Tool registry | 100 lines |
| Individual substantial tool | 200 lines |
| Discord adapter component | 300 lines |

Keep a larger cohesive state machine together when splitting would create coupled fragments. Split
when a file has multiple reasons to change. No file should combine several of Discord events,
Discord output/lookups, session state, provider translation, orchestration, tool side effects, and
persistence serialization.

## Testing approach

- Start with Node's built-in test runner and the existing TypeScript toolchain.
- Establish the exact TypeScript test command in Phase 1.
- Add Vitest only if timers or TypeScript execution are materially painful.
- Use behavior-oriented tests rather than coverage targets.
- Use temporary directories; never touch live `logs` data in tests.
- Use fakes at owned boundaries instead of deeply mocking provider or Discord SDK objects.

Primary fakes:

- `ScriptedModel` records requests and returns predetermined turns.
- `RecordingTransport` records messages, reactions, typing, statuses, and presence.
- Controlled tools return continue, finish, and failure outcomes.
- Message builders produce readable application messages with useful defaults.

Highest-value tests:

- Orchestrator tool loops, terminal outcomes, failures, history, and iteration limits.
- Session wake/sleep, batching, typing, processing queues, channel FIFO, and idle timing.
- Tool validation, Discord resolution, routing, scheduling, and controlled failures.
- Schedule/timezone calculations, mentions, prompts, emoji validation, and pricing.
- Store round trips, malformed data, and compatibility with current JSON shapes.
- Provider request/response translation using fixtures without live API calls.

Do not test provider SDK internals, Discord network behavior, logger formatting, trivial constructors,
or private methods individually.

## Feature-parity checklist

Meaningful logic should have an automated test unless it is inherently an external integration
check.

### Discord and lifecycle

- [ ] Required intents, message/typing/interaction/error handlers, and shutdown handling.
- [ ] Ignore bot messages and normalize human messages without leaking SDK types.
- [ ] Detect direct pings and register/handle `/usage`.
- [ ] Send messages, reactions, typing, status logs, and presence safely.
- [ ] Resolve user/channel mentions and escape `@everyone`/`@here`.
- [ ] Restrict allowed mentions and reject missing or ambiguous lookups.

### Session and context

- [ ] Start sleeping and keep bounded recent context by channel.
- [ ] Wake on ping, keep one active channel, and queue other channels FIFO.
- [ ] Batch messages, respect typing activity, and refresh Ben's typing indicator.
- [ ] Queue messages received during processing and promote them afterward.
- [ ] Wait while preserving memory; sleep while clearing memory and advancing queued wakes.
- [ ] Return to sleep after idle timeout and update awake/idle presence.
- [ ] Include pre-wake context, pinging user, summaries, known people, local time, and activity status.
- [ ] Preserve model history while awake and save a required summary on sleep.

### Model and orchestration

- [ ] Perform one provider request per model invocation with provider-neutral tools/history.
- [ ] Execute capability tools and return results to the model.
- [ ] Support reply, reaction, combined reply/reaction, wait, and sleep.
- [ ] Enforce the tool-call policy and bounded iteration count.
- [ ] Surface public reasoning summaries when available.
- [ ] Convert model/tool failures into controlled outcomes.
- [ ] Enforce the daily budget across conversation and internal model calls.

### Tools

- [ ] Remember a verified user and reject empty, duplicate, or unresolved people.
- [ ] Send to a uniquely resolved server channel and report failures.
- [ ] Add successful cross-channel bot output to recent context.
- [ ] Schedule messages for verified users with validated content, destination, creator, and time.
- [ ] Reject broadcast targets, unresolved users, past dates, and invalid repeats.
- [ ] Return useful model-readable results for all tool successes and failures.

### Scheduling

- [ ] Preserve one-time, daily, and weekly schedule data.
- [ ] Interpret dates in the bot timezone and calculate recurrence correctly.
- [ ] Deliver safe target pings, complete one-time schedules, and advance recurring schedules.
- [ ] Skip recurring occurrences missed before startup and find the next future run.
- [ ] Retain failed schedules, increment failures, and log creation/delivery/failure.

### Persistence, usage, and internal status

- [ ] Read current summaries, known people, schedules, usage, and internal-state files.
- [ ] Preserve atomic writes and intentional malformed-entry handling.
- [ ] Record input/cached/output/total tokens and compatible daily/monthly usage.
- [ ] Calculate model cost, treat zero budget as unlimited, and format `/usage`.
- [ ] Reuse fresh saved activity status and refresh stale status on its interval.
- [ ] Validate, persist, apply, and log activity status without overlapping runs.

## Phases

### Phase 0 — Baseline and preparation

Status: Complete

- [x] Record scope, architecture, testing, parity, and cutover decisions.
- [x] Run the existing build without starting the server.
- [x] Attempt the existing lint command and record the result.
- [x] Confirm representative current JSON shapes with sanitized fixtures.
- [x] Confirm the six-variable environment contract in documentation.
- [x] Decide where prompts live during the parallel migration.

Baseline on 2026-08-10:

- `pnpm build` passes.
- `pnpm lint` cannot execute because the local `eslint` binary is missing. No dependency was
  installed or changed during planning.
- Sanitized fixtures now cover the current conversation-summary, known-people, scheduled-message,
  monthly-usage, and internal-status JSON shapes. They were derived from the current readers and
  writers because no live `logs` files were present in this checkout.
- The environment contract is the six variables documented in the Configuration table above.
- During parallel development, replacement prompts live under `src-next/prompts`. They are copied
  assets so `src-next` remains independent and the production `src` prompt paths remain unchanged.

Done when the current baseline and data compatibility requirements are known without changing the
production entry point.

### Phase 1 — Scaffold and test harness

Status: Complete

- [x] Create the `src-next` skeleton and isolated `tsconfig.next.json`/output directory.
- [x] Add non-runtime type-check and test scripts without changing the current dev/start scripts.
- [x] Establish the Node TypeScript test command and one passing test.
- [x] Implement the reduced environment loader and port the logger.
- [x] Add test builders/fakes only when first used.

Completed on 2026-08-10:

- `pnpm typecheck:next` type-checks `src-next` without emitting into the production `dist` tree.
- `pnpm test:next` uses Node's test runner with the `tsx` import hook and passes four environment
  loader tests.
- The reduced loader accepts only the six-variable contract, trims string values, validates the
  log level, budget, and boolean flag, and requires the Discord and current OpenAI credentials.
- No builders or fakes were added because Phase 1 tests do not need them yet.
- Neither replacement command imports the entry point, logs in to Discord, or starts a bot.

Done when `src-next` type-checks and tests independently without starting either bot.

### Phase 2 — Application contracts and conversation core

Status: Complete

- [x] Define normalized messages, history, model turns, tools, outcomes, and usage.
- [x] Define narrow `Model`, `Tool`, and `ChatTransport` contracts.
- [x] Port pure scheduling, prompt, mention-safe, emoji, and pricing behavior with tests.
- [x] Implement `ToolRegistry` and terminal conversation controls.
- [x] Implement and test the provider-neutral `ConversationOrchestrator`.
- [x] Resolve portable history versus opaque provider continuation state.

Completed on 2026-08-10:

- Application history is fully portable and contains normalized messages, reasoning, tool calls,
  and tool results. Opaque provider continuation state is not part of the application contract.
- The orchestrator enforces one tool call per turn, loops through capability tools, returns terminal
  reply/react/wait/sleep outcomes, reports tool failures to the model, and bounds iterations.
- Tests cover the conversation loop, terminal behavior, scheduling and DST handling, prompt
  formatting, broadcast safety, emoji validation, and token pricing.
- Review corrections restored the existing readable TypeScript style and full pricing table, added
  JSDoc to public APIs, ensured unexpected tool calls receive matching failure results, and expanded
  the Phase 2 suite to 33 tests.

Done when the complete conversation/tool loop runs through fakes without OpenAI or Discord.

### Phase 3 — OpenAI adapter and usage

Status: Complete

- [x] Translate application requests/history/tools into Responses API requests.
- [x] Translate text, reasoning, tool calls, and continuation data back into application types.
- [x] Port usage persistence, pricing, reasoning summaries, and budget enforcement.
- [x] Use local constants for models and provider request limits.
- [x] Cover translations and existing usage shapes with fixtures; make no live API calls.

Completed on 2026-08-10:

- `OpenAIModel` performs one stateless Responses API request per invocation, requires one generic
  registered function call, disables parallel calls, records returned usage, and checks the shared
  daily budget before contacting the provider through a provider-neutral application error.
- `OpenAIMapper` translates only provider-neutral history and tool definitions. It privately
  associates portable reasoning items with encrypted continuation payloads so OpenAI SDK data does
  not enter application contracts.
- `OpenAIUsageStore` reads the existing monthly JSON shape, rejects malformed totals, writes
  atomically, prices cached/uncached/output tokens by the model used for each request, and treats a
  zero daily budget as unlimited.
- Conversation and internal model names and the conversation output-token limit are local constants
  under `model/openai`; the adapter contains no Ben-specific tool names.
- The replacement suite now has 43 passing tests, including request/response translation, reasoning
  continuation, malformed tool arguments, budget blocking, current usage fixtures, atomic writes,
  and usage aggregation. No live API calls are made.

Done when OpenAI types remain inside `model/openai` and the adapter knows no Ben tool names.

### Phase 4 — Discord boundary

Status: Not started

- [ ] Implement client/event input through `DiscordAdapter`.
- [ ] Implement output through `DiscordTransport` and decide presence ownership.
- [ ] Port directories, mentions, member/channel resolution, and broadcast safety.
- [ ] Test through a small owned Discord gateway/client boundary without network calls.

Done when application code imports no `discord.js` types and Discord input/output are separate from
session state.

### Phase 5 — Bot session

Status: Not started

- [ ] Implement wake/awake/processing/sleep state and bounded sleeping context.
- [ ] Implement batching, typing-aware debounce, active-channel behavior, and queued wakes.
- [ ] Invoke the orchestrator and apply outcomes through `ChatTransport`.
- [ ] Use local production timings with narrow test overrides.
- [ ] Test wake, timing, processing queues, channel FIFO, outcomes, idle sleep, and memory clearing.

Done when session behavior runs completely with a scripted orchestrator and recording transport.

### Phase 6 — Persistence and Discord tools

Status: Not started

- [ ] Port summary and known-people stores with current-shape compatibility tests.
- [ ] Implement remember-person and cross-channel-message tools.
- [ ] Connect summaries/people to prompt context at the correct lifecycle points.
- [ ] Preserve atomic writes and successful cross-channel context updates.
- [ ] Test validation, resolution, duplicates, ambiguity, and controlled failures.

Done when existing data remains readable and Discord tools register without edits to model or
orchestrator code.

### Phase 7 — Scheduled messages

Status: Not started

- [ ] Port the scheduled store, scheduler, target resolution, and delivery.
- [ ] Implement the scheduled-message tool.
- [ ] Preserve one-time, recurring, missed-run, logging, and failure behavior.
- [ ] Test existing shapes, recurrence, missed schedules, failure accounting, and validation.

Done when existing schedules retain their intended next run and tests use no live state or Discord.

### Phase 8 — Operational features and composition

Status: Not started

- [ ] Port `/usage` registration/formatting and full budget behavior.
- [ ] Port internal status generation, persistence, scheduling, logging, and presence.
- [ ] Decide how internal actions reuse the model boundary.
- [ ] Compose the replacement in a small `src-next/index.ts`.
- [ ] Test fresh/stale status, action failures/budget/overlap, and composition without login.
- [ ] Review all files against responsibility and size guardrails.

Done when every current feature is composed and `index.ts` contains wiring rather than business
logic.

### Phase 9 — Parity and cutover readiness

Status: Not started

- [ ] Resolve or explicitly accept every parity checklist item.
- [ ] Run replacement type-check, lint, and tests.
- [ ] Verify persisted-data compatibility using fixtures or copies, never concurrent live writes.
- [ ] Search for prohibited cross-boundary SDK imports and `src-next` imports from `src`.
- [ ] Confirm reduced environment documentation and local constants.
- [ ] Document intentional behavior changes and prepare the cutover/rollback commits.

Done when the replacement is accepted as the only implementation before any live process changes.

### Phase 10 — Cutover and cleanup

Status: Not started; requires explicit approval

- [ ] Stop the existing bot before starting the replacement.
- [ ] Preserve state files and a known-good pre-cutover Git revision.
- [ ] Replace `src` with the reviewed replacement and normalize scripts/configuration.
- [ ] Build, lint, and test the final tree.
- [ ] Start the replacement once through the normal user-controlled workflow.
- [ ] Verify readiness, one conversation, `/usage`, status output, and scheduler startup.
- [ ] Remove temporary old source/configuration only after verification.
- [ ] Update the README and condense or remove this plan.

Rollback by stopping the replacement, restoring the pre-cutover revision without deleting persisted
data, and starting only the restored implementation.

Done when one verified `src` remains and all normal scripts target it.

## Decisions

- Use a temporary parallel `src-next` tree with no imports from `src`.
- Center the design on `Model`, `Tool`, and `ChatTransport`.
- Keep JSON persistence and compatible data shapes.
- Use local constants rather than a global settings file.
- Keep the six-variable environment contract.
- Begin with Node's test runner, co-located tests, and no coverage target.
- Keep tests in co-located `__tests__` directories and run them with
  `node --import tsx --test src-next/__tests__/*.test.ts src-next/*/__tests__/*.test.ts`.
- Keep prompt copies under `src-next/prompts` during the parallel migration; remove the duplicate
  production assets only during the approved cutover.
- Prefer small fakes at owned boundaries over SDK mocks.
- Treat file-size thresholds as review prompts, not rules.
- Keep this one living plan rather than separate planning systems.
- Use portable conversation history only; provider-specific continuation state remains inside an
  adapter and is not required by the application contract.
- Associate OpenAI encrypted reasoning continuations with in-memory portable reasoning items inside
  `OpenAIMapper`; omit continuation data when history did not originate from that adapter instance.

## Open questions

- Same `Model` interface for internal actions, or a narrower operation?
- Copied prompts in `src-next`, or neutral root-level prompt assets?
- Presence inside `ChatTransport`, or a separate small capability?
- Which existing-toolchain command provides the cleanest TypeScript tests and timer control?

Resolve questions only when their phase needs an answer, then move the result into Decisions.

## Definition of done

- The replacement is the only `src` implementation.
- Application code imports neither `discord.js` nor provider SDK types.
- A provider requires an adapter and composition wiring, not session/orchestrator changes.
- A capability tool requires an implementation and registry entry, not model-adapter changes.
- Important state, orchestration, scheduling, persistence, and tool behavior has tests.
- Existing persisted data remains usable.
- The `.env` contract contains only the agreed external/operational values.
- Composition files contain wiring rather than accumulated behavior.
- No file combines unrelated Discord, provider, session, tool, and persistence concerns.
- The old implementation and temporary migration configuration are removed.
