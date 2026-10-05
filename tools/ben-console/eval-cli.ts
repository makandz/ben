import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "dotenv";
import { assertConsoleRoot } from "./session.js";
import { parseSuite } from "./evaluation-schema.js";
import { runScenarios, renderReport, compareRuns, loadEvidence } from "./evaluation.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    suite: { type: "string", default: "tools/ben-console/scenarios/baseline.json" },
    scenario: { type: "string", multiple: true },
    repeat: { type: "string", default: "1" },
    root: { type: "string", default: ".ben-console/evaluations" },
    "base-prompt": { type: "string" },
    "messaging-prompt": { type: "string" },
    output: { type: "string" },
  },
});
const [command = "run", ...paths] = positionals;
try {
  if (command === "run") {
    config({ quiet: true });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY (environment or .env)");
    const suite = parseSuite(JSON.parse(await readFile(values.suite, "utf8")) as unknown);
    const selected = values.scenario ?? suite.scenarios.map((item) => item.id);
    for (const id of selected)
      if (!suite.scenarios.some((item) => item.id === id))
        throw new Error(`Unknown scenario: ${id}`);
    const prompts: { base?: string; messaging?: string } = {};
    if (values["base-prompt"])
      prompts.base = await readFile(resolve(values["base-prompt"]), "utf8");
    if (values["messaging-prompt"])
      prompts.messaging = await readFile(resolve(values["messaging-prompt"]), "utf8");
    const repeat = Number(values.repeat);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
      throw new Error("Repeat must be 1 through 20");
    const root = resolve(values.root);
    await assertConsoleRoot(root);
    await mkdir(root, { recursive: true });
    const batch = await mkdtemp(join(root, "batch-"));
    const abort = new AbortController();
    const interrupt = () => {
      process.stderr.write(
        "Interrupt requested; preserving evidence and draining the current session.\n",
      );
      abort.abort();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const directories = await runScenarios(
      suite.scenarios.filter((item) => selected.includes(item.id)),
      {
        root: batch,
        apiKey,
        repeat,
        signal: abort.signal,
        ...(Object.keys(prompts).length ? { prompts } : {}),
      },
    );
    const evidence = await Promise.all(directories.map((directory) => loadEvidence(directory)));
    await writeFile(
      join(batch, "index.md"),
      `# Evaluation batch\n\nReview: pending. Execution completion is not a semantic grade.\n\n| Run | Execution |\n| --- | --- |\n${evidence.map(({ packet }, index) => `| [${packet.id}](${directories[index] ?? ""}/report.md) | ${packet.status} |`).join("\n")}\n`,
    );
    if (evidence.some(({ packet }) => packet.status !== "complete")) process.exitCode = 1;
    process.stdout.write(`${batch}\n${directories.join("\n")}\n`);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (abort.signal.aborted) process.exitCode = 130;
  } else if (command === "report") {
    if (paths.length !== 1 || !paths[0])
      throw new Error("Usage: console:eval report RUN_DIRECTORY");
    process.stdout.write(`${await renderReport(resolve(paths[0]))}\n`);
  } else if (command === "compare") {
    if (paths.length !== 2 || !paths[0] || !paths[1])
      throw new Error("Usage: console:eval compare BASELINE_RUN CANDIDATE_RUN [--output FILE]");
    const report = await compareRuns(resolve(paths[0]), resolve(paths[1]));
    if (values.output) await writeFile(resolve(values.output), report);
    else process.stdout.write(report);
  } else
    throw new Error(
      "Commands: run [--scenario ID] [--repeat N] [--base-prompt FILE] [--messaging-prompt FILE], report RUN_DIRECTORY, compare BASELINE_RUN CANDIDATE_RUN",
    );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
