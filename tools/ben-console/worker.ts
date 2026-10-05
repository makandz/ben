import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { parseCommand } from "./protocol.js";
import { serialize, startSession } from "./session.js";
import type { SessionOptions } from "./session.js";

/**
 * Creates a persistent protocol dispatcher; model work never blocks subsequent input.
 * @param options - Artifact root, dev state path, event output and optional deterministic model.
 * @returns Input-line and shutdown controls.
 */
export function createWorker(options: SessionOptions) {
  let session: Awaited<ReturnType<typeof startSession>> | undefined;
  let lifecycle: Promise<void> | undefined;
  let stopped = false;
  let shutdownWork: Promise<void> | undefined;
  const emit = options.emit;
  const handle = async (line: string) => {
    let op: string | undefined;
    try {
      const command = parseCommand(line);
      op = command.op;
      if (stopped) throw new Error("Worker is stopped");
      if (lifecycle) throw new Error("Session lifecycle transition in progress; wait for result");
      if (command.op === "start" || command.op === "stop") {
        if (command.op === "start" && session) throw new Error("Session already started");
        // Defer setup so lifecycle is installed before any awaited operation or emitted event.
        lifecycle = Promise.resolve().then(async () => {
          if (command.op === "stop") {
            await session?.stop();
            session = undefined;
            stopped = true;
            emit({ type: "result", op, status: "stopped" });
          } else {
            const { op: _op, ...settings } = command;
            void _op;
            session = await startSession(options, settings);
            emit({
              type: "result",
              op,
              status: "ready",
              directory: session.directory,
              logPath: session.logPath,
              tracePath: session.tracePath,
              transcriptPath: session.transcriptPath,
              stateDirectory: session.stateDirectory,
              stateMode: session.stateMode,
              fresh: session.fresh,
              usageDirectory: session.usageDirectory,
            });
          }
        });
        try {
          await lifecycle;
        } finally {
          lifecycle = undefined;
        }
        return;
      }
      if (!session) throw new Error("Start a session first");
      if (command.op === "inspect") {
        emit({ type: "result", op, state: await session.inspect() });
      } else {
        const inputs = command.op === "batch" ? command.messages : [command];
        emit({ type: "result", op, messageIds: session.message(inputs) });
      }
    } catch (error) {
      emit({ type: "error", op: op ?? null, error });
    }
  };
  return {
    handle,
    async shutdown() {
      stopped = true;
      shutdownWork ??= (async () => {
        if (lifecycle) await lifecycle.catch(() => undefined);
        await session?.stop();
        session = undefined;
      })();
      await shutdownWork;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  config({ quiet: true });
  const apiKey = process.env.OPENAI_API_KEY;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const worker = createWorker({
    root: resolve(process.env.BEN_CONSOLE_ROOT ?? ".ben-console"),
    ...(apiKey ? { apiKey } : {}),
    diagnostic: (line) => {
      process.stderr.write(`${line}\n`);
    },
    emit: (event) => {
      process.stdout.write(`${serialize(event, [apiKey ?? ""])}\n`);
      if (event.type === "result" && event.status === "stopped") lines.close();
    },
  });
  lines.on("line", (line) => {
    if (line.trim()) void worker.handle(line);
  });
  const shutdown = async () => {
    lines.close();
    await worker.shutdown();
  };
  lines.once("close", () => {
    void worker.shutdown().catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}
