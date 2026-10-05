import { z } from "zod";
import { inputSchema, startSchema } from "./protocol.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const criterion = z.object({ id: identifier, description: z.string().min(1) }).strict();
const step = z.discriminatedUnion("op", [
  z.object({ op: z.literal("messages"), messages: z.array(inputSchema).min(1).max(100) }).strict(),
  z
    .object({
      op: z.literal("fail"),
      operation: z.enum(["send", "reaction", "typing", "presence", "status"]),
      count: z.number().int().min(1).max(100).default(1),
    })
    .strict(),
  z.object({ op: z.literal("inspect") }).strict(),
  z.object({ op: z.literal("wait"), ms: z.number().int().min(1).max(60000) }).strict(),
  z
    .object({
      op: z.literal("wait-turns"),
      count: z.number().int().min(1).max(100),
      timeoutMs: z.number().int().min(1).max(60000).default(30000),
    })
    .strict(),
]);
const scenarioSchema = z
  .object({
    id: identifier,
    description: z.string().min(1),
    settings: startSchema.strict().default({}),
    criteria: z.array(criterion).min(1),
    steps: z.array(step).min(1).max(100),
  })
  .strict();
const suiteSchema = z
  .object({ version: z.literal(1), scenarios: z.array(scenarioSchema).min(1) })
  .strict();
export type Scenario = z.infer<typeof scenarioSchema>;
export type Suite = z.infer<typeof suiteSchema>;
const assessmentSchema = z
  .object({
    criterionId: identifier,
    status: z.enum(["pass", "fail", "inconclusive"]),
    reasoning: z.string().trim().min(1),
    evidence: z.array(z.number().int().positive()).min(1),
    issueSource: z.enum(["prompt", "runtime", "tool", "simulation"]).optional(),
  })
  .strict();
export const reviewSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    reviewer: z.string().trim().min(1),
    assessments: z.array(assessmentSchema),
  })
  .strict();
export type Review = z.infer<typeof reviewSchema>;

/**
 * Validates scenario definitions and stable, unique scenario and rubric identifiers.
 * @param value - Parsed suite JSON.
 * @returns Validated suite without inferred semantic judgments.
 * @throws When fields, identifiers, criteria, speakers, or channels are invalid.
 */
export function parseSuite(value: unknown): Suite {
  const suite = suiteSchema.parse(value);
  const ids = new Set<string>();
  for (const scenario of suite.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario: ${scenario.id}`);
    ids.add(scenario.id);
    const criteria = new Set<string>();
    for (const item of scenario.criteria) {
      if (criteria.has(item.id)) throw new Error(`Duplicate criterion: ${item.id}`);
      criteria.add(item.id);
    }
    const users = scenario.settings.users ?? ["makan", "alex"];
    const channels = scenario.settings.channels ?? ["general", "games", "ben-log"];
    if (new Set(users).size !== users.length || new Set(channels).size !== channels.length)
      throw new Error(`Duplicate directory entries: ${scenario.id}`);
    for (const item of scenario.steps)
      if (item.op === "messages")
        for (const message of item.messages) {
          if (message.user && !users.includes(message.user))
            throw new Error(`Unknown speaker: ${message.user}`);
          if (message.channel && !channels.includes(message.channel))
            throw new Error(`Unknown channel: ${message.channel}`);
        }
  }
  return suite;
}

/**
 * Validates a saved human/Codex review against one run's rubric and actual ordered trace.
 * @param value - Parsed review JSON; omitted criteria remain pending.
 * @param runId - Exact run identifier from the evidence packet.
 * @param scenario - Snapshotted criteria being assessed.
 * @param sequences - Existing trace sequence identifiers, including diagnostics.
 * @returns Evidence-backed saved assessments.
 * @throws When a review targets another run, repeats criteria, or cites missing evidence.
 */
export function validateReview(
  value: unknown,
  runId: string,
  scenario: Scenario,
  sequences: Set<number>,
): Review {
  const review = reviewSchema.parse(value);
  if (review.runId !== runId) throw new Error("Review runId does not match evidence packet");
  const seen = new Set<string>();
  for (const item of review.assessments) {
    if (!scenario.criteria.some((criterion) => criterion.id === item.criterionId))
      throw new Error(`Unknown criterion: ${item.criterionId}`);
    if (seen.has(item.criterionId)) throw new Error(`Duplicate assessment: ${item.criterionId}`);
    seen.add(item.criterionId);
    for (const sequence of item.evidence)
      if (!sequences.has(sequence)) throw new Error(`Missing trace evidence: ${String(sequence)}`);
  }
  return review;
}
