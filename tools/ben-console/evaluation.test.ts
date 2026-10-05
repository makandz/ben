import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel } from "../../src/testing/ScriptedModel.js";
import type { Model, ModelTurn } from "../../src/model/Model.js";
import { TaskStore } from "../../src/storage/TaskStore.js";
import { startSession } from "./session.js";
import { parseSuite, validateReview } from "./evaluation-schema.js";
import { runScenarios, loadEvidence, renderReport, compareRuns } from "./evaluation.js";

const turn = (name: string, args: unknown = {}): ModelTurn => ({
  items: [{ type: "tool_call", callId: "call", name, arguments: args }],
});
const suite = () =>
  parseSuite({
    version: 1,
    scenarios: [
      {
        id: "test-case",
        description: "A reviewable conversation",
        settings: {
          timings: { messageDebounceMs: 0 },
          timeoutMs: 1000,
          seed: { "memories.json": { version: 1, memories: ["starting context"] } },
        },
        criteria: [{ id: "appropriate-wait", description: "Wait without inventing speech." }],
        steps: [
          { op: "messages", messages: [{ user: "alex", content: "quiet context" }] },
          {
            op: "messages",
            messages: [{ content: "@Ben just wait" }, { user: "alex", content: "yes please" }],
          },
          { op: "inspect" },
        ],
      },
    ],
  });
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ben-eval-test-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("baseline suite parses and rejects duplicate IDs, unknown speakers and unsupported steps", async () => {
  const baseline = parseSuite(await readJson("tools/ben-console/scenarios/baseline.json"));
  assert.equal(baseline.scenarios.length, 8);
  const definition = suite();
  assert.throws(
    () =>
      parseSuite({ ...definition, scenarios: [...definition.scenarios, ...definition.scenarios] }),
    /Duplicate scenario/,
  );
  const scenario = required(definition.scenarios[0]);
  assert.throws(
    () =>
      parseSuite({
        version: 1,
        scenarios: [{ ...scenario, criteria: [...scenario.criteria, ...scenario.criteria] }],
      }),
    /Duplicate criterion/,
  );
  assert.throws(
    () =>
      parseSuite({
        version: 1,
        scenarios: [
          {
            ...scenario,
            steps: [{ op: "messages", messages: [{ content: "hi", user: "stranger" }] }],
          },
        ],
      }),
    /Unknown speaker/,
  );
  assert.throws(() =>
    parseSuite({ version: 1, scenarios: [{ ...scenario, steps: [{ op: "arbitrary-script" }] }] }),
  );
});

test("repetitions isolate state, snapshots preserve candidates, and reviews stay pending", async () => {
  const f = await fixture();
  const production = await readFile("src/prompts/messaging.md", "utf8");
  try {
    const model = new ScriptedModel([turn("sleep", { summary: "first only" }), turn("wait")]);
    const runs = await runScenarios(suite().scenarios, {
      root: f.root,
      model,
      repeat: 2,
      prompts: { messaging: "candidate instructions" },
    });
    assert.equal(runs.length, 2);
    const a = await loadEvidence(required(runs[0]));
    const b = await loadEvidence(required(runs[1]));
    assert.equal(a.packet.status, "complete");
    assert.equal(b.packet.status, "complete");
    assert.equal(a.packet.steps[0]?.status, "no-wake");
    assert.equal(model.requests.length, 2);
    assert.notEqual(a.packet.session, b.packet.session);
    assert.doesNotMatch(
      await readFile(join(required(runs[1]), "starting-state.json"), "utf8"),
      /first only/,
    );
    assert.match(
      await readFile(join(required(runs[0]), required(a.packet.session), "prompts.json"), "utf8"),
      /candidate instructions/,
    );
    assert.equal(await readFile("src/prompts/messaging.md", "utf8"), production);
    assert.match(await readFile(join(required(runs[0]), "report.md"), "utf8"), /pending/);
    assert.doesNotMatch(
      await compareRuns(required(runs[0]), required(runs[0])),
      /candidate pass after baseline fail/,
    );
    assert.match(await compareRuns(required(runs[0]), required(runs[0])), /unassessed/);
    assert.throws(() => validateReview({}, a.packet.id, a.packet.scenario, new Set()));
    const template = await readJson(join(required(runs[0]), "review-template.json"));
    assert.throws(() =>
      validateReview(
        template,
        a.packet.id,
        a.packet.scenario,
        new Set(a.trace.map((event) => Number(event.sequence))),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("saved assessments require actual evidence and comparisons require compatible runs", async () => {
  const f = await fixture();
  try {
    const [baseline] = await runScenarios(suite().scenarios, {
      root: f.root,
      model: new ScriptedModel([turn("wait")]),
    });
    const [candidate] = await runScenarios(suite().scenarios, {
      root: f.root,
      model: new ScriptedModel([turn("wait")]),
      prompts: { base: "candidate base" },
    });
    assert.ok(baseline && candidate);
    const evidence = await loadEvidence(baseline);
    const sequences = new Set(evidence.trace.map((event) => Number(event.sequence)));
    const review = {
      version: 1,
      runId: evidence.packet.id,
      reviewer: "Codex",
      assessments: [
        {
          criterionId: "appropriate-wait",
          status: "fail",
          reasoning: "Read the cited turn and state",
          evidence: [
            Number(evidence.trace.find((event) => event.type === "turn_completed")?.sequence),
          ],
          issueSource: "prompt",
        },
      ],
    };
    assert.throws(
      () =>
        validateReview(
          { ...review, runId: "another-run" },
          evidence.packet.id,
          evidence.packet.scenario,
          sequences,
        ),
      /runId/,
    );
    assert.throws(
      () =>
        validateReview(
          { ...review, assessments: [{ ...review.assessments[0], evidence: [999999] }] },
          evidence.packet.id,
          evidence.packet.scenario,
          sequences,
        ),
      /Missing trace/,
    );
    assert.throws(
      () =>
        validateReview(
          { ...review, assessments: [...review.assessments, ...review.assessments] },
          evidence.packet.id,
          evidence.packet.scenario,
          sequences,
        ),
      /Duplicate/,
    );
    assert.throws(
      () =>
        validateReview(
          { ...review, assessments: [{ ...review.assessments[0], criterionId: "invented" }] },
          evidence.packet.id,
          evidence.packet.scenario,
          sequences,
        ),
      /Unknown criterion/,
    );
    await writeFile(join(baseline, "review.json"), JSON.stringify(review));
    await renderReport(baseline);
    assert.match(await readFile(join(baseline, "report.md"), "utf8"), /likely prompt/);
    assert.match(await compareRuns(baseline, candidate), /unassessed/);
    const other = await loadEvidence(candidate);
    await writeFile(
      join(candidate, "review.json"),
      JSON.stringify({
        ...review,
        runId: other.packet.id,
        assessments: [
          {
            ...review.assessments[0],
            status: "pass",
            evidence: [
              Number(other.trace.find((event) => event.type === "turn_completed")?.sequence),
            ],
          },
        ],
      }),
    );
    assert.match(await compareRuns(baseline, candidate), /candidate pass after baseline fail/);
    await writeFile(
      join(candidate, required(other.packet.session), "config.json"),
      JSON.stringify({ ...(other.config as object), dailyBudgetUsd: 99 }),
    );
    await assert.rejects(compareRuns(baseline, candidate), /Incompatible/);
  } finally {
    await f.cleanup();
  }
});

test("send failures and timeouts preserve evidence and drained state without pretending to pass", async () => {
  const f = await fixture();
  try {
    const scenario = required(suite().scenarios[0]);
    const failure = {
      ...scenario,
      steps: [
        { op: "fail" as const, operation: "send" as const, count: 1 },
        { op: "messages" as const, messages: [{ content: "@Ben hello" }] },
      ],
    };
    const [failed] = await runScenarios([failure], {
      root: f.root,
      model: new ScriptedModel([
        turn("message", { text: "hello", reply_to: null, next_action: "wait" }),
        turn("sleep", { summary: "Handled failure" }),
      ]),
    });
    assert.ok(failed);
    const failEvidence = await loadEvidence(failed);
    assert.ok(failEvidence.trace.some((event) => event.type === "discord_send" && event.failed));
    assert.match(await readFile(join(failed, "report.md"), "utf8"), /delivery failed/);
    const delayed: Model = {
      async invoke() {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return turn("sleep", { summary: "Late drained state" });
      },
    };
    const [timed] = await runScenarios(
      [{ ...scenario, settings: { ...scenario.settings, timeoutMs: 10 } }],
      { root: f.root, model: delayed },
    );
    assert.ok(timed);
    const timedEvidence = await loadEvidence(timed);
    assert.equal(timedEvidence.packet.status, "incomplete");
    assert.equal(timedEvidence.packet.steps.at(-1)?.status, "timeout");
    assert.ok(timedEvidence.trace.some((event) => event.type === "stopped"));
    assert.match(await readFile(join(timed, "final-state.json"), "utf8"), /Late drained state/);
    assert.match(await readFile(join(timed, "report.md"), "utf8"), /steps not observed/);
  } finally {
    await f.cleanup();
  }
});

test("scheduler opt-in executes and completes an overdue one-time task in isolated state", async () => {
  const f = await fixture();
  try {
    const definition = parseSuite(await readJson("tools/ben-console/scenarios/baseline.json"));
    const scenario = required(definition.scenarios.find((item) => item.id === "scheduled-task"));
    const [run] = await runScenarios([scenario], {
      root: f.root,
      model: new ScriptedModel([
        turn("message", {
          text: "Bring the board game",
          reply_to: null,
          next_action: "sleep",
          sleep_summary: "Reminder delivered",
        }),
      ]),
    });
    assert.ok(run);
    const evidence = await loadEvidence(run);
    assert.equal(evidence.packet.status, "complete");
    assert.ok(
      evidence.trace.some((event) => event.type === "session_wake" && event.source === "task"),
    );
    assert.ok(
      evidence.trace.some(
        (event) => event.type === "diagnostic" && event.event === "tasks.completed",
      ),
    );
    assert.doesNotMatch(await readFile(join(run, "final-state.json"), "utf8"), /task_eval_overdue/);
    assert.ok(
      !evidence.trace.some(
        (event) =>
          event.type === "diagnostic" && event.event === "memory.consolidation_scheduler_started",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("runner rejects live-state overlap before writing artifacts", async () => {
  await assert.rejects(
    runScenarios(suite().scenarios, {
      root: join(process.cwd(), "logs", "forbidden-evaluation-root"),
      model: new ScriptedModel([]),
    }),
    /must not overlap/,
  );
});

test("partial candidate overrides preserve suite prompt layers and invalid reviews block reports", async () => {
  const f = await fixture();
  try {
    const scenario = required(suite().scenarios[0]);
    const [run] = await runScenarios(
      [
        {
          ...scenario,
          settings: {
            ...scenario.settings,
            prompts: { base: "suite base", messaging: "suite messaging" },
          },
        },
      ],
      {
        root: f.root,
        model: new ScriptedModel([turn("wait")]),
        prompts: { messaging: "candidate messaging" },
      },
    );
    assert.ok(run);
    const evidence = await loadEvidence(run);
    const snapshot = await readFile(
      join(run, required(evidence.packet.session), "prompts.json"),
      "utf8",
    );
    assert.match(snapshot, /suite base/);
    assert.match(snapshot, /candidate messaging/);
    assert.doesNotMatch(snapshot, /suite messaging/);
    await writeFile(
      join(run, "review.json"),
      JSON.stringify({
        version: 1,
        runId: evidence.packet.id,
        reviewer: "Codex",
        assessments: [
          {
            criterionId: "appropriate-wait",
            status: "pass",
            reasoning: "No trace read",
            evidence: [999999],
          },
        ],
      }),
    );
    await assert.rejects(renderReport(run), /Missing trace/);
  } finally {
    await f.cleanup();
  }
});

test("immediate scheduler shutdown drains startup without late trace writes or model work", async () => {
  const f = await fixture();
  const unhandled: unknown[] = [];
  const observeRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observeRejection);
  try {
    const definition = parseSuite(await readJson("tools/ben-console/scenarios/baseline.json"));
    const scenario = required(definition.scenarios.find((item) => item.id === "scheduled-task"));
    for (const repeat of ["none", "daily"] as const) {
      const settings = {
        ...scenario.settings,
        seed: {
          "tasks.json": {
            version: 1,
            revision: 1,
            tasks: [
              {
                id: "shutdown-task",
                version: 1,
                name: "Shutdown task",
                description: "Isolated shutdown regression",
                instructions: "Send a reminder",
                destination: { kind: "current", channelId: "2000", channelName: "general" },
                runDate: "2020-01-01",
                runTime: "18:00",
                repeat,
                nextRunAt: "2020-01-01T23:00:00.000Z",
                createdAt: "2019-12-31T00:00:00.000Z",
                updatedAt: "2019-12-31T00:00:00.000Z",
              },
            ],
          },
        },
      };
      const model = new ScriptedModel([]);
      const session = await startSession({ root: f.root, model, emit() {} }, settings);
      await session.stop();
      const trace = await readFile(session.tracePath, "utf8");
      const state = await readFile(join(session.directory, "state/tasks.json"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await readFile(session.tracePath, "utf8"), trace);
      assert.equal(await readFile(join(session.directory, "state/tasks.json"), "utf8"), state);
      assert.equal(model.requests.length, 0);
      assert.deepEqual(unhandled, []);
      assert.doesNotMatch(trace, /"event":"tasks.queued"/);
    }
  } finally {
    process.removeListener("unhandledRejection", observeRejection);
    await f.cleanup();
  }
});

test("shutdown drains already-started idle occurrence persistence before closing artifacts", async () => {
  const f = await fixture();
  const unhandled: unknown[] = [];
  const observeRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observeRejection);
  let releaseWrite!: () => void;
  let savingStarted!: () => void;
  const saving = new Promise<void>((resolve) => {
    savingStarted = resolve;
  });
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  // Preserve the method for restoration; the gate invokes it with the actual store receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = TaskStore.prototype.completeOccurrence;
  TaskStore.prototype.completeOccurrence = async function (
    this: TaskStore,
    ...args: Parameters<TaskStore["completeOccurrence"]>
  ) {
    savingStarted();
    await writeGate;
    return original.apply(this, args);
  };
  let session: Awaited<ReturnType<typeof startSession>> | undefined;
  try {
    const definition = parseSuite(await readJson("tools/ben-console/scenarios/baseline.json"));
    const scenario = required(definition.scenarios.find((item) => item.id === "scheduled-task"));
    const model = new ScriptedModel([turn("wait")]);
    session = await startSession(
      { root: f.root, model, emit() {} },
      {
        ...scenario.settings,
        timings: { messageDebounceMs: 0, idleSleepMs: 10 },
      },
    );
    await saving;
    let stopped = false;
    const stopping = session.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stopped, false, "shutdown must own the already-started idle completion");
    const beforeRelease = await readFile(join(session.directory, "state/tasks.json"), "utf8");
    assert.match(beforeRelease, /task_eval_overdue/);
    releaseWrite();
    await stopping;
    const trace = await readFile(session.tracePath, "utf8");
    const state = await readFile(join(session.directory, "state/tasks.json"), "utf8");
    assert.doesNotMatch(state, /task_eval_overdue/);
    assert.match(trace, /"event":"tasks.completed"/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await readFile(session.tracePath, "utf8"), trace);
    assert.equal(await readFile(join(session.directory, "state/tasks.json"), "utf8"), state);
    assert.equal(model.requests.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    releaseWrite();
    await session?.stop();
    TaskStore.prototype.completeOccurrence = original;
    process.removeListener("unhandledRejection", observeRejection);
    await f.cleanup();
  }
});
