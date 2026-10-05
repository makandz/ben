import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { parseSuite, validateReview } from "./evaluation-schema.js";
import type { Scenario } from "./evaluation-schema.js";
import { assertConsoleRoot, serialize, startSession } from "./session.js";
import type { SessionOptions, StartOptions } from "./session.js";

const packetSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  repetition: z.number().int().positive(),
  scenario: z.unknown(),
  status: z.enum(["running", "complete", "incomplete"]),
  session: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(
    z.object({
      index: z.number(),
      status: z.string(),
      firstSequence: z.number(),
      lastSequence: z.number(),
      snapshot: z.string(),
    }),
  ),
});
export type Packet = Omit<z.infer<typeof packetSchema>, "scenario"> & { scenario: Scenario };
export type RunOptions = Omit<SessionOptions, "emit"> & {
  repeat?: number;
  prompts?: StartOptions["prompts"];
  signal?: AbortSignal;
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;
const save = async (path: string, value: unknown) => writeFile(path, `${serialize(value)}\n`);

/**
 * Runs independent repetitions with isolated state and preserves evidence before review.
 * @param scenarios - Validated scenarios with acceptance criteria defined before execution.
 * @param options - Artifact root, model boundary, repeat count and optional candidate prompt text.
 * @returns Completed evidence directories, including incomplete executions.
 * @throws When repeat counts are invalid or filesystem/session setup cannot complete.
 */
export async function runScenarios(scenarios: Scenario[], options: RunOptions): Promise<string[]> {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
    throw new Error("Repeat must be 1 through 20");
  parseSuite({ version: 1, scenarios });
  await assertConsoleRoot(options.root);
  await mkdir(options.root, { recursive: true });
  const directories: string[] = [];
  for (const scenario of scenarios)
    for (let repetition = 1; repetition <= repeat; repetition++) {
      if (options.signal?.aborted) return directories;
      const directory = await mkdtemp(join(options.root, `${scenario.id}-${String(repetition)}-`));
      directories.push(directory);
      const packet: Packet = {
        version: 1,
        id: basename(directory),
        repetition,
        scenario,
        status: "running",
        steps: [],
      };
      const packetPath = join(directory, "packet.json");
      await save(packetPath, packet);
      await save(join(directory, "review-template.json"), {
        version: 1,
        runId: packet.id,
        reviewer: "",
        assessments: scenario.criteria.map((item) => ({
          criterionId: item.id,
          status: null,
          reasoning: "",
          evidence: [],
        })),
      });
      let session: Awaited<ReturnType<typeof startSession>> | undefined;
      const events: Record<string, unknown>[] = [];
      try {
        session = await startSession(
          { ...options, root: directory, emit: (event) => events.push(event) },
          {
            ...scenario.settings,
            ...(options.prompts
              ? { prompts: { ...scenario.settings.prompts, ...options.prompts } }
              : {}),
          },
        );
        packet.session = basename(session.directory);
        const active = session;
        const snapshot = async (name: string) => {
          const { events: _events, ...state } = await active.inspect();
          void _events;
          await save(join(directory, name), state);
        };
        await snapshot("starting-state.json");
        for (const [index, step] of scenario.steps.entries()) {
          if (options.signal?.aborted) throw new Error("Interrupted; shutdown drains active work");
          const firstSequence = Number(events.at(-1)?.sequence ?? 0) + 1;
          let status = "complete";
          if (step.op === "messages") {
            const requestId = `step-${String(index + 1)}`;
            session.message(requestId, step.messages);
            while (
              !events.some((event) => event.type === "settled" && event.requestId === requestId)
            ) {
              if (options.signal?.aborted) throw new Error("Interrupted during observation");
              await delay(10);
            }
            status = String(
              events.find((event) => event.type === "settled" && event.requestId === requestId)
                ?.status,
            );
          } else if (step.op === "fail") session.local.fail(step.operation, step.count);
          else if (step.op === "wait") {
            const deadline = Date.now() + step.ms;
            while (Date.now() < deadline && !options.signal?.aborted)
              await delay(Math.min(25, deadline - Date.now()));
          } else if (step.op === "wait-turns") {
            const deadline = Date.now() + step.timeoutMs;
            while (
              events.filter((event) => event.type === "turn_completed").length < step.count &&
              Date.now() < deadline &&
              !options.signal?.aborted
            )
              await delay(10);
            if (events.filter((event) => event.type === "turn_completed").length < step.count)
              status = "timeout";
          }
          const snapshotName = `step-${String(index + 1)}.json`;
          await snapshot(snapshotName);
          packet.steps.push({
            index: index + 1,
            status,
            firstSequence,
            lastSequence: Number(events.at(-1)?.sequence ?? 0),
            snapshot: snapshotName,
          });
          await save(packetPath, packet);
          if (status === "timeout" || status === "stopped" || status === "failed")
            throw new Error(`Step ${String(index + 1)} ${status}; remaining steps were not run`);
        }
        if (options.signal?.aborted) throw new Error("Interrupted during observation");
        packet.status = "complete";
      } catch (error) {
        packet.status = "incomplete";
        packet.error = error instanceof Error ? error.message : String(error);
      } finally {
        // Save the observation result before draining; a late completion cannot erase a timeout.
        await save(packetPath, packet);
        try {
          await session?.stop();
        } catch (error) {
          packet.status = "incomplete";
          packet.error = `Shutdown: ${String(error)}`;
        }
        if (session) {
          const { events: _events, ...state } = await session.inspect();
          void _events;
          await save(join(directory, "final-state.json"), state);
        }
        await save(packetPath, packet);
        await renderReport(directory);
      }
    }
  return directories;
}

/**
 * Reads and validates one saved evidence packet and its ordered trace.
 * @param directory - Scenario repetition directory.
 * @returns Packet, snapshotted config and trace events for review or comparison.
 * @throws When artifacts or the scenario definition are invalid.
 */
export async function loadEvidence(directory: string) {
  const raw = packetSchema.parse(await json(join(directory, "packet.json")));
  const scenario = parseSuite({ version: 1, scenarios: [raw.scenario] }).scenarios[0];
  if (!scenario) throw new Error("Missing scenario");
  const packet: Packet = { ...raw, scenario };
  const trace = packet.session
    ? (await readFile(join(directory, packet.session, "trace.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    : [];
  const config = packet.session ? await json(join(directory, packet.session, "config.json")) : null;
  return { packet, trace, config };
}

async function readReview(directory: string, evidence: Awaited<ReturnType<typeof loadEvidence>>) {
  try {
    return validateReview(
      await json(join(directory, "review.json")),
      evidence.packet.id,
      evidence.packet.scenario,
      new Set(evidence.trace.map((event) => Number(event.sequence))),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
const inline = (value: unknown) => String(value).replaceAll("\n", " ").replaceAll("|", "\\|");

/**
 * Regenerates the readable report from actual execution evidence and optional saved assessments.
 * @param directory - Scenario repetition directory containing packet.json and optional review.json.
 * @returns Report path; missing assessments remain explicitly pending.
 * @throws When saved assessments contain invalid criteria or trace references.
 */
export async function renderReport(directory: string): Promise<string> {
  const evidence = await loadEvidence(directory);
  const { packet, trace } = evidence;
  const review = await readReview(directory, evidence);
  const lines = [
    `# ${packet.scenario.id} / repetition ${String(packet.repetition)}`,
    "",
    packet.scenario.description,
    "",
    `Execution: **${packet.status}**${packet.error ? ` (${packet.error})` : ""}. Review: ${review ? inline(review.reviewer) : "**pending**"}.`,
    "",
    "Completion describes observation only; it is not a semantic pass. An incomplete execution cannot establish a full scenario pass.",
    "",
    "| Criterion | Acceptance criterion | Assessment | Reasoning and trace evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const criterion of packet.scenario.criteria) {
    const assessment = review?.assessments.find((item) => item.criterionId === criterion.id);
    lines.push(
      `| ${criterion.id} | ${inline(criterion.description)} | ${assessment?.status ?? "pending"} | ${assessment ? `${inline(assessment.reasoning)}; seq ${assessment.evidence.join(", ")}${assessment.issueSource ? `; likely ${assessment.issueSource}` : ""}` : "No saved assessment"} |`,
    );
  }
  lines.push("", "## Observation steps", "");
  for (const step of packet.steps)
    lines.push(
      `- Step ${String(step.index)}: ${step.status}; ${step.firstSequence <= step.lastSequence ? `trace seq ${String(step.firstSequence)}..${String(step.lastSequence)}` : "no new trace events"}; [state/messages](${step.snapshot}).`,
    );
  if (packet.steps.length < packet.scenario.steps.length)
    lines.push(
      `- ${String(packet.scenario.steps.length - packet.steps.length)} steps not observed.`,
    );
  lines.push(
    "",
    "## Conversation and tool evidence",
    "",
    "Sequence numbers refer to the complete JSONL trace; read tool results and state before grading claims.",
    "",
  );
  for (const event of trace) {
    const sequence = String(event.sequence);
    if (event.type === "discord_input") {
      const input = z
        .object({ author: z.object({ username: z.string() }), content: z.string() })
        .parse(event.message);
      lines.push(`- ${sequence} ${input.author.username}: ${inline(input.content)}`);
    } else if (event.type === "discord_send")
      lines.push(
        `- ${sequence} Ben${event.failed ? " (delivery failed)" : ""}: ${inline(event.content)}`,
      );
    else if (
      event.type === "tool_call" ||
      event.type === "tool_result" ||
      event.type === "turn_completed" ||
      event.type === "discord_reaction" ||
      event.type === "session_sleep" ||
      event.type === "failure_plan"
    )
      lines.push(`- ${sequence} ${event.type}: ${inline(serialize(event))}`);
  }
  lines.push(
    "",
    "## Complete artifacts",
    "",
    "- [Scenario and observation packet](packet.json)",
    "- [Review template](review-template.json). Copy to review.json, fill reviewer and evidence-backed assessments, omit unassessed criteria. Null template statuses are intentionally invalid.",
    "- [Starting state](starting-state.json) and [drained final state](final-state.json).",
  );
  if (packet.session)
    lines.push(
      `- [Readable log](${packet.session}/session.log), [ordered trace](${packet.session}/trace.jsonl), [config/seed](${packet.session}/config.json), [prompt snapshots](${packet.session}/prompts.json).`,
    );
  const path = join(directory, "report.md");
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

/**
 * Compares matching repetitions and rubric criteria without inferring missing judgments.
 * @param baseline - Baseline scenario repetition directory.
 * @param candidate - Candidate scenario repetition directory.
 * @returns Markdown comparison; incompatible evidence is explicitly rejected.
 * @throws When scenario definitions, repetition, seeds, settings, or model config differ.
 */
export async function compareRuns(baseline: string, candidate: string): Promise<string> {
  const left = await loadEvidence(baseline);
  const right = await loadEvidence(candidate);
  const definition = (scenario: Scenario) => ({
    ...scenario,
    settings: { ...scenario.settings, prompts: undefined },
  });
  if (
    JSON.stringify(definition(left.packet.scenario)) !==
      JSON.stringify(definition(right.packet.scenario)) ||
    left.packet.repetition !== right.packet.repetition ||
    JSON.stringify(left.config) !== JSON.stringify(right.config) ||
    left.config === null
  )
    throw new Error(
      "Incompatible runs: require the same scenario, rubric, repetition, seed, settings, timezone and model config",
    );
  const a = await readReview(baseline, left);
  const b = await readReview(candidate, right);
  const lines = [
    `# Comparison: ${left.packet.scenario.id}`,
    "",
    `Baseline execution: ${left.packet.status}; candidate execution: ${right.packet.status}.`,
    "",
    "| Criterion | Baseline | Candidate | Comparison |",
    "| --- | --- | --- | --- |",
  ];
  for (const criterion of left.packet.scenario.criteria) {
    const first = a?.assessments.find((item) => item.criterionId === criterion.id);
    const second = b?.assessments.find((item) => item.criterionId === criterion.id);
    let result = "unassessed";
    if (first && second) {
      if (
        left.packet.status !== "complete" ||
        right.packet.status !== "complete" ||
        first.status === "inconclusive" ||
        second.status === "inconclusive"
      )
        result = "inconclusive";
      else if (first.status === second.status) result = "same assessment";
      else
        result =
          first.status === "fail"
            ? "candidate pass after baseline fail"
            : "candidate fail after baseline pass";
    }
    lines.push(
      `| ${criterion.id} | ${first?.status ?? "pending"} | ${second?.status ?? "pending"} | ${result} |`,
    );
  }
  lines.push(
    "",
    `Read [baseline report](${join(baseline, "report.md")}) and [candidate report](${join(candidate, "report.md")}) for reasons and sequence evidence.`,
    "",
    "These are saved reviewer judgments, not an automatic semantic grade. Repeat important cases and review related scenarios before adopting a prompt change.",
  );
  return `${lines.join("\n")}\n`;
}
