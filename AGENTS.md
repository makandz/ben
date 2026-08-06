Ben is a TypeScript Discord bot that uses the official OpenAI SDK. It is a small side project made for fun on a private Discord server.

## Workflow

- Do not run the app. Assume it is already running.
- Do not install dependencies. Tell me what you want to install and wait for me to do it.
- Ask before making broad architectural changes.

## Code

- Keep changes small, simple, and easy to review.
- Do not over-engineer.
- Prefer the architecture that makes the most sense rather than blindly following existing patterns.
- The project currently has no tests.

### Documentation

- Put a documentation comment directly above every function and method.
- Exported functions and public interface methods must use full JSDoc with `@param` and `@returns` tags.
- Internal helpers and callbacks may use a concise single-line `/** ... */` comment.
