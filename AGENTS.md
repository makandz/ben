# AGENTS.md

You are working in the **Ben** repository, a Discord bot used in a private server with friends.

Ben is an AI-powered member of the server. It participates in conversations, can call tools, and should feel like a natural part of the Discord experience rather than a traditional command-only bot.

## Development assumptions

- Assume the development server is already running unless told otherwise. Do not start or restart the server unless necessary or explicitly requested.
- Use Conventional Commit prefixes for commit messages, such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`.
- Use Git directly for commits and pushes. Do not require GitHub CLI authentication unless the task specifically needs GitHub API features such as pull requests.
- If a GitHub authentication check fails inside a network-restricted sandbox, repeat the check outside the sandbox before asking the user to authenticate again. DNS or network failures can be misreported as invalid credentials.

## TypeScript conventions

- Prefer `type` over `interface` for TypeScript types.
- Follow the existing project style and patterns when they are clear.
- Keep implementations simple and avoid unnecessary abstractions.

## Documentation

- Every exported function must use full JSDoc with a summary, an `@param` entry for every
  parameter, and an `@returns` entry for every non-`void` return value. For `Promise<void>`,
  document the meaningful completion point. Add `@throws` for intentional validation or domain
  errors that callers should handle.
- Public methods on exported classes follow the same rule. Synchronous `void` functions and
  methods may omit `@returns`.
- Type aliases and members declared only within types do not require documentation. Put JSDoc on
  concrete functions and method implementations instead.
- Exported classes should have a short summary.
- Do not repeat TypeScript types in JSDoc. Parameter and return descriptions should explain
  semantics, constraints, or completion behavior that the signature does not express.
- Private/internal functions may use a short single-line doc comment, for example:

```ts
/** Resolves the active conversation for a Discord message. */
```

- Use full JSDoc for private/internal functions when their behavior is complex enough to warrant
  it. Trivial formatters and predicates do not require comments solely for coverage.
