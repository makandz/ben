import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { parseCommand } from "./protocol.js";
import { serialize, startSession } from "./session.js";
import type { SessionOptions, StartOptions } from "./session.js";

/**
 * Creates a persistent protocol dispatcher; model work never blocks subsequent input.
 * @param options - Isolated session root, event output and optional deterministic model.
 * @returns Input-line and shutdown controls.
 */
export function createWorker(options: SessionOptions) {
  let session: Awaited<ReturnType<typeof startSession>> | undefined;
  let settings: StartOptions = {};
  let lifecycle: Promise<void> | undefined;
  let transitioning = false;
  let stopped = false;
  const seen = new Set<string>();
  const emit = options.emit;
  const handle = async (line: string) => {
    let id: string | undefined;
    try {
      const raw: unknown = JSON.parse(line);
      if (typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string")
        id = raw.id;
      const command = parseCommand(line);
      id = command.id;
      if (seen.has(id)) throw new Error("Duplicate request id");
      if (stopped) throw new Error("Worker is stopped");
      if (transitioning)
        throw new Error("Session lifecycle transition in progress; wait for result/ready");
      seen.add(id);
      if (command.op === "start" || command.op === "reset" || command.op === "stop") {
        if (command.op === "start" && session)
          throw new Error("Session already started; use reset");
        if (command.op === "reset" && !session) throw new Error("Start a session first");
        transitioning = true;
        emit({ type: "ack", requestId: id, op: command.op });
        lifecycle = (async () => {
          if (session) await session.stop();
          session = undefined;
          if (command.op === "stop") {
            stopped = true;
            emit({ type: "result", requestId: id, status: "stopped" });
            return;
          }
          if (command.op === "start") {
            const { id: _id, op: _op, ...rest } = command;
            void _id;
            void _op;
            settings = rest;
          }
          session = await startSession(options, settings);
          emit({
            type: "result",
            requestId: id,
            status: "ready",
            directory: session.directory,
            logPath: session.logPath,
            tracePath: session.tracePath,
          });
        })();
        try {
          await lifecycle;
        } finally {
          transitioning = false;
          lifecycle = undefined;
        }
        return;
      }
      if (!session) throw new Error("Start a session first");
      switch (command.op) {
        case "message":
        case "batch": {
          const inputs = command.op === "batch" ? command.messages : [command];
          for (const input of inputs) session.local.validate(input);
          emit({ type: "ack", requestId: id, op: command.op });
          const messageIds = session.message(id, inputs);
          emit({ type: "injected", requestId: id, messageIds });
          break;
        }
        case "typing":
          session.local.typing(command.user, command.channel);
          emit({ type: "ack", requestId: id, op: command.op });
          break;
        case "fail":
          session.local.fail(command.operation, command.count);
          emit({ type: "ack", requestId: id, op: command.op });
          break;
        case "inspect":
          emit({ type: "ack", requestId: id, op: command.op });
          emit({ type: "result", requestId: id, state: await session.inspect() });
          break;
      }
    } catch (error) {
      emit({ type: "error", requestId: id ?? null, error });
    }
  };
  return {
    handle,
    async shutdown() {
      if (lifecycle) await lifecycle.catch(() => undefined);
      if (session && !stopped) {
        await session.stop();
        session = undefined;
      }
      stopped = true;
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
