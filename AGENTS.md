# Ben

Ben is an AI member of a private Discord server with friends. He should feel like a natural participant in conversations.

## Development

- Assume Ben is already running. Do not start, restart, or stop him unless needed for the task or explicitly requested.
- Worktrees copy the same credentials and share logs/, which contains persisted runtime state. Do not run multiple Ben instances against that shared state. Use isolated state for tests.

Ben's personality and runtime instructions live in src/prompts. This file guides development of Ben.
