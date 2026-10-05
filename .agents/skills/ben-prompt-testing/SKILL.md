---
name: ben-prompt-testing
description: Test Ben's conversational behavior through adaptive console conversations, and validate authorized prompt changes against an observed baseline. Use for requests to try Ben's behavior or fix his prompts, not general console implementation work.
---

# Ben prompt testing

Use real conversations to understand behavior and assess focused prompt changes. Read the [console README](../../../tools/ben-console/README.md) for commands, artifacts, budgets and lifecycle mechanics.

1. Agree the intended behavior and a complex mock conversation with the user before implementation. Define the scenario for this task, not a predefined suite, runner or framework. Cover many relevant cases in a coherent conversation: unpinged follow-ups while Ben is active, unpinged context while he sleeps, group conversation he should stay out of, and interleaved references to different people or targets. Follow the complex cases with simple ones to check basic behavior still works. Resolve material choices without inventing new requirements.
2. Read the relevant prompts in `src/prompts` and actual tool descriptions before testing or proposing wording changes. Run an authorized baseline against the current prompts. Choose subsequent messages, timing and synthetic participants from Ben's actual responses and lifecycle outcomes, allowing him time to respond. The mock run guides the conversation; it is not a fixed script. Injection acknowledgement is not response completion.
3. Inspect actual tool calls, arguments, results and reply/wait/sleep outcomes alongside delivered messages. Use `conversation.md`, and consult `trace.jsonl`, `session.log` or `inspect` when behavior is uncertain. Judge whether Ben acted correctly, including when he stayed silent, rather than matching keywords in his prose. Separate observations from interpretation.
4. When prompt editing is authorized, make the smallest change that addresses the observed cause. Prefer replacing existing wording over appending special-case rules. Own the console restart needed to load changed prompts and run an adaptive candidate conversation covering the agreed behavior and baseline failure. Preserve the baseline artifacts. Do not restart live Ben merely to test prompts.
5. Repeat targeted uncertain cases only when the evidence warrants it, proportionally to the remaining uncertainty and within the authorized scope and budget. Stop when the agreed behavior has enough evidence for review, or report a material uncertainty or blocker. A successful conversation is evidence, not proof of consistent behavior from a nondeterministic model.
6. Show the compact full baseline and candidate transcripts, preserving actual speakers, messages, tool calls, arguments, results and lifecycle outcomes. Link the artifacts and give concise findings, what changed and remaining risks. Do not substitute selected excerpts or a prose summary for the conversations.

For a conversation-only request, follow the relevant conversation steps without changing prompts. This skill does not authorize prompt edits, live API conversations, extra agents or broader experiments; use the user's existing authorization and clarify only material gaps.

Default to persisted dev state in `logs/`; use `fresh: true` only when explicitly requested. Persisted files do not restore an active in-memory conversation. Use one Ben process per shared state directory. Stop dev Ben for console takeover only with session authorization or when needed under the project development instructions. Own and cleanly stop the console process you start. Automated offline tests always use temporary state. Never save or emit system prompts, prompt snapshots, full model requests, provider histories or hidden reasoning in testing artifacts.
