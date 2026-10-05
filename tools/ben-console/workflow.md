# On-demand conversations

Use this workflow when the user asks to talk with Ben or try a behavior through the console. The user task and any optional behavior instructions define the conversation; there is no predefined evaluation suite or grading step.

1. Read the user task and behavior instructions. Choose the initial messages and any synthetic users or channels needed for that task.
2. Own a separate console process in this checkout using `pnpm --silent console`. It runs this checkout's application code and prompts against a local gateway with isolated state. A running console is never an attachment to production Ben. Keep stdin open, send `{"op":"start"}` with any needed settings, and wait for the start result with `status: "ready"`. Save the absolute artifact paths, including `transcriptPath`.
3. Inject the first message with the appropriate user and channel. Use `@Ben` or `ping: true` to wake him. Read actual deliveries and choose subsequent messages or personas based on what Ben says and the user's task. Give him room to respond before choosing the next follow-up. A message command result only acknowledges injection; it does not mean Ben has finished responding.
4. Read the actual tool calls, results and reply/wait/sleep outcomes alongside messages in `conversation.md`. Inspect `session.log` or `trace.jsonl` when more context is needed to understand behavior. Use `inspect` for local messages, persisted state and usage. Full model histories, instructions, diagnostics and operational status deliveries stay in the diagnostic artifacts.
5. Send `{"op":"stop"}` and wait for the stopped result. Shutdown drains in-flight work and persistence; it can take as long as an active model request. Stop only the console process you own, leaving live Ben alone.
6. Show the readable conversation from `conversation.md`, preserving the actual messages, speakers, tool calls/results and lifecycle outcomes. Include brief observations tied to the user task and links to the transcript and relevant diagnostic artifacts. Distinguish observed behavior from your interpretation.

Modify prompts, restart after changes, or repeat a conversation only when the user authorizes that work. Use a fresh isolated session when repeating; preserve earlier artifacts. See the [console README](README.md) for commands, directory settings, budgets and lifecycle details.
