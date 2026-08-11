# AGENTS.md

You are working in the **Ben** repository, a Discord bot used in a private server with friends.

Ben is an AI-powered member of the server. It participates in conversations, can call tools, and should feel like a natural part of the Discord experience rather than a traditional command-only bot.

## Development assumptions

- Assume the development server is already running unless told otherwise. Do not start or restart the server unless necessary or explicitly requested.
- Use Conventional Commit prefixes for commit messages, such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`.
- Use Git directly for commits and pushes. Do not require GitHub CLI authentication unless the task specifically needs GitHub API features such as pull requests.

## TypeScript conventions

- Prefer `type` over `interface` for TypeScript types.
- Follow the existing project style and patterns when they are clear.
- Keep implementations simple and avoid unnecessary abstractions.

## Documentation

- Public functions should use JSDoc and document parameters and return values where applicable.
- Private/internal functions may use a short single-line doc comment, for example:

```ts
/** Resolves the active conversation for a Discord message. */
```

- Use full JSDoc for private/internal functions when their behavior is complex enough to warrant it.
