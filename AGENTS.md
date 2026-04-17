# AGENTS.md

## Repository Guidelines

- Keep `src/index.ts` focused on application wiring and event orchestration.
- Extract reusable logic into focused modules instead of growing a single-file implementation.
- When adding or updating JSDoc, include explicit `@param` tags for each parameter and an explicit `@returns` tag for the return value, including `void`/“Nothing” cases when applicable.
- Preserve existing behavior while refactoring unless the task explicitly calls for a behavior change.
