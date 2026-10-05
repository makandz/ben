# Ben

Ben is an AI member of a private Discord server with friends. He should feel like a natural participant in conversations.

## Development

- Assume Ben is already running. Do not start, restart, or stop him unless needed for the task or explicitly requested.
- Worktrees copy the same credentials and share logs/, which contains persisted runtime state. Do not run multiple Ben instances against that shared state. Use isolated state for tests.

## Console

- The console defaults to persisted dev state in `logs/`; transcripts and session usage stay in `.ben-console/`. Use only one Ben process per shared state directory.
- Stop dev Ben before console takeover only with session authorization or when needed under the development instructions above. Request `fresh: true` explicitly for empty OS temporary state; saved files do not restore an active in-memory conversation.
- Automated offline console tests must use temporary state, never the shared `logs/` state.

Ben's personality and runtime instructions live in src/prompts. This file guides development of Ben.
