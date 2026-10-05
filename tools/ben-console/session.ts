import { appendFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  writeFile,
  lstat,
  readlink,
} from "node:fs/promises";
import { join, resolve, relative, dirname, basename } from "node:path";
import type { ExecutionEvent } from "../../src/app/ExecutionObserver.js";
import { createApplication } from "../../src/app/createApplication.js";
import { Logger } from "../../src/logger.js";
import type { Model, ModelRequest } from "../../src/model/Model.js";
import { OpenAIModel, OPENAI_CONVERSATION_MODEL } from "../../src/model/openai/OpenAIModel.js";
import { OpenAIUsageStore } from "../../src/model/openai/OpenAIUsageStore.js";
import { composeInstructions } from "../../src/prompting/promptLayers.js";
import { createGateway } from "./gateway.js";
import type { InputMessage } from "./gateway.js";
import type { Command } from "./protocol.js";

export type StartOptions = Omit<Extract<Command, { op: "start" }>, "op" | "id">;
export type SessionOptions = {
  root: string;
  emit: (event: Record<string, unknown>) => void;
  model?: Model;
  apiKey?: string;
  diagnostic?: (line: string) => void;
};
type Pending = {
  requestId: string;
  messageIds: string[];
  timer: NodeJS.Timeout;
  outcomes: unknown[];
};

/**
 * Serializes error messages and stacks while removing credentials from diagnostic artifacts.
 * @param value - Runtime event or response.
 * @param secrets - Credential values to scrub from strings.
 * @returns JSON text suitable for one protocol or trace line.
 */
export function serialize(value: unknown, secrets: string[] = []): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Error)
      return { name: item.name, message: item.message, stack: item.stack, cause: item.cause };
    if (typeof item === "string")
      for (const secret of secrets)
        if (secret) item = (item as string).replaceAll(secret, "[REDACTED]");
    return item;
  });
}

/** Resolves nonexistent suffixes and dangling symlink ancestors without creating paths. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  try {
    if ((await lstat(absolute)).isSymbolicLink()) {
      return await canonicalPath(resolve(dirname(absolute), await readlink(absolute)));
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return join(await canonicalPath(dirname(absolute)), basename(absolute));
}

/**
 * Starts one isolated application session with live ordered artifacts.
 * @param options - Session filesystem root and owned output/model boundaries.
 * @param settings - Synthetic directory, timing, spending and seed settings.
 * @returns Running session controls with drain-before-stop semantics.
 * @throws When the root overlaps live logs, credentials are absent, or setup fails.
 */
export async function startSession(options: SessionOptions, settings: StartOptions = {}) {
  const root = await canonicalPath(options.root);
  const production = await canonicalPath(resolve("logs"));
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
  };
  if (inside(production, root) || inside(root, production))
    throw new Error("Console root must not overlap live logs");
  if (!options.model && !options.apiKey)
    throw new Error("Missing OPENAI_API_KEY for real model session");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "session-"));
  const stateDirectory = join(directory, "state");
  await mkdir(stateDirectory);
  const secrets = [options.apiKey ?? ""];
  const tracePath = join(directory, "trace.jsonl");
  const logPath = join(directory, "session.log");
  let sequence = 0;
  let closed = false;
  const events: Record<string, unknown>[] = [];
  const record = (value: Record<string, unknown>, publish = true) => {
    if (closed) throw new Error("Cannot write a closed console session");
    const event = JSON.parse(
      serialize(
        { sequence: ++sequence, timestamp: new Date().toISOString(), session: directory, ...value },
        secrets,
      ),
    ) as Record<string, unknown>;
    appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
    let detail = serialize(value, secrets);
    if (event.type === "discord_send")
      detail = `${String(event.channelId)} Ben: ${String(event.content)}`;
    if (event.type === "discord_input") {
      const message = event.message as {
        channel: { name: string };
        author: { username: string };
        content: string;
        id: string;
      };
      detail = `#${message.channel.name} ${message.author.username} (${message.id}): ${message.content}`;
    }
    if (event.type === "model_request") {
      const request = value.request as ModelRequest;
      const lastUser = [...request.history]
        .reverse()
        .find((item) => item.type === "message" && item.role === "user");
      detail = `tools=${String(request.tools.length)} history=${String(request.history.length)}\n${lastUser?.type === "message" ? lastUser.text : ""}`;
    }
    for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
    appendFileSync(
      logPath,
      `${String(event.sequence)} ${String(event.timestamp)} ${String(event.type)} ${detail}\n`,
    );
    events.push(event);
    if (publish) options.emit(event);
    return event;
  };
  const logger = Object.assign(
    new Logger("debug"),
    Object.fromEntries(
      ["debug", "info", "warn", "error"].map((level) => [
        level,
        (event: string, data?: Record<string, unknown>) => {
          const diagnostic = record({ type: "diagnostic", level, event, data }, false);
          options.diagnostic?.(serialize(diagnostic, secrets));
        },
      ]),
    ),
  );
  const [base = "", messaging = "", consolidation = ""] = await Promise.all(
    ["base", "messaging", "memory-consolidation"].map((name) =>
      readFile(new URL(`../../src/prompts/${name}.md`, import.meta.url), "utf8"),
    ),
  );
  const prompts = { base, messaging, "memory-consolidation": consolidation };
  const instructions = composeInstructions(base, messaging);
  const consolidationInstructions = composeInstructions(base, consolidation);
  const budget = settings.dailyBudgetUsd ?? 1;
  const timings = {
    messageDebounceMs: settings.timings?.messageDebounceMs ?? 100,
    typingDebounceMs: settings.timings?.typingDebounceMs ?? 1000,
    idleSleepMs: settings.timings?.idleSleepMs ?? 300000,
    typingRefreshMs: settings.timings?.typingRefreshMs ?? 8000,
  };
  await writeFile(
    join(directory, "prompts.json"),
    serialize({ ...prompts, instructions, consolidationInstructions }),
  );
  await writeFile(
    join(directory, "config.json"),
    serialize({
      model: options.model ? "injected" : OPENAI_CONVERSATION_MODEL,
      maxOutputTokens: 512,
      reasoningEffort: "high",
      dailyBudgetUsd: budget,
      timings,
      schedulers: false,
      users: settings.users ?? ["makan", "alex"],
      channels: settings.channels ?? ["general", "games", "ben-log"],
      timeoutMs: settings.timeoutMs ?? 30000,
    }),
  );
  for (const [name, seed] of Object.entries(settings.seed ?? {}))
    await writeFile(
      join(stateDirectory, name),
      name.endsWith(".txt") ? String(seed) : JSON.stringify(seed),
    );
  const local = createGateway(record, settings);
  const usageStore = new OpenAIUsageStore(
    join(stateDirectory, "openai-usage"),
    OPENAI_CONVERSATION_MODEL,
    budget,
    logger,
  );
  const model = options.model ?? new OpenAIModel({ apiKey: options.apiKey ?? "" }, usageStore);
  const pending = new Map<string, Pending>();
  let mode = "sleeping";
  let channelId: string | undefined;
  let lastResult: ExecutionEvent | undefined;
  let turnRequests: string[] = [];
  let turnPrompt: string | undefined;
  let consumedIds: string[] = [];
  let shutdownWork: Promise<void> | undefined;
  let stopping = false;
  const finish = (requestId: string, status: string, extra: Record<string, unknown> = {}) => {
    const request = pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(requestId);
    record({ type: "settled", requestId, status, ...extra });
  };
  const observer = (event: ExecutionEvent) => {
    if (event.type === "session_wake") {
      mode = "awake";
      channelId = event.channelId;
    }
    if (event.type === "session_sleep") {
      mode = "sleeping";
      channelId = undefined;
    }
    if (event.type === "model_request") {
      mode = "processing";
      const lastUser = [...event.request.history]
        .reverse()
        .find((item) => item.type === "message" && item.role === "user");
      const prompt = lastUser?.type === "message" ? lastUser.text : "";
      if (prompt !== turnPrompt) {
        turnPrompt = prompt;
        consumedIds = [...pending.values()].flatMap((request) =>
          request.messageIds.filter((id) => prompt.includes(`<message_id:${id}>`)),
        );
        turnRequests = [...pending.values()]
          .filter((request) =>
            request.messageIds.some((id) => prompt.includes(`<message_id:${id}>`)),
          )
          .map((request) => request.requestId);
      }
    }
    record({ ...event, requestIds: turnRequests });
    if (event.type === "turn_completed") {
      lastResult = event;
      if (mode === "processing") mode = "awake";
      const requests = turnRequests;
      turnRequests = [];
      turnPrompt = undefined;
      for (const requestId of requests) {
        const request = pending.get(requestId);
        if (!request) continue;
        request.messageIds = request.messageIds.filter((id) => !consumedIds.includes(id));
        request.outcomes.push({ outcome: event.outcome, channelId: event.channelId });
        if (request.messageIds.length === 0)
          finish(
            requestId,
            event.outcome.type === "wait"
              ? "wait"
              : event.outcome.type === "failed"
                ? "failed"
                : "complete",
            { outcome: event.outcome, outcomes: request.outcomes, channelId: event.channelId },
          );
      }
      consumedIds = [];
    }
  };
  const application = createApplication({
    env: {
      discordToken: "local-only",
      openaiApiKey: "",
      discordLogChannelId: local.channels.find((item) => item.name === "ben-log")?.id,
      discordAdminUserId: undefined,
      openaiDailyBudgetUsd: budget,
      logLevel: "debug",
    },
    logger,
    gateway: local.gateway,
    conversationModel: model,
    consolidationModel: model,
    instructions,
    consolidationInstructions,
    usageStore,
    stateDirectory,
    sessionTimings: timings,
    observer,
    startSchedulers: false,
  });
  await application.start();
  record({
    type: "ready",
    logPath,
    tracePath,
    stateDirectory,
    users: local.users,
    channels: local.channels,
  });
  return {
    directory,
    logPath,
    tracePath,
    local,
    settings,
    message(requestId: string, inputs: InputMessage[]) {
      if (stopping) throw new Error("Session is stopping");
      for (const input of inputs) local.validate(input);
      record({ type: "input_request", requestId, inputs });
      const wasSleeping = mode === "sleeping";
      const timer = setTimeout(
        () =>
          finish(requestId, "timeout", {
            message:
              "No terminal outcome within observation bound; work may still be queued or processing",
          }),
        settings.timeoutMs ?? 30000,
      );
      const request: Pending = { requestId, messageIds: [], timer, outcomes: [] };
      pending.set(requestId, request);
      const delivered = inputs.map((input) => local.message(input));
      request.messageIds = delivered.map((message) => message.id);
      if (
        wasSleeping &&
        !delivered.some((message) => message.mentionedUsers.some((person) => person.bot))
      )
        finish(requestId, "no-wake");
      return delivered.map((message) => message.id);
    },
    async inspect() {
      const state: Record<string, unknown> = {};
      for (const name of await readdir(stateDirectory)) {
        if (name === "openai-usage") continue;
        const content = await readFile(join(stateDirectory, name), "utf8");
        try {
          state[name] = JSON.parse(content);
        } catch {
          state[name] = content;
        }
      }
      return {
        directory,
        mode,
        channelId,
        lastResult,
        pending: [...pending.keys()],
        users: local.users,
        channels: local.channels,
        messages: local.messages,
        state,
        usage: await usageStore.getBudgetStatus(),
        events,
      };
    },
    async stop() {
      shutdownWork ??= (async () => {
        stopping = true;
        await application.stop();
        for (const requestId of pending.keys())
          finish(requestId, "stopped", {
            message: "Input was not observed in a completed turn before shutdown",
          });
        record({ type: "stopped" });
        closed = true;
      })();
      await shutdownWork;
    },
  };
}
