import assert from "node:assert/strict";
import test from "node:test";
import { Logger, type LoggerOptions } from "../logger.js";

function capture(level: "debug" | "info" | "warn" | "error" = "info", options: LoggerOptions = {}) {
  const lines: string[] = [];
  const logger = new Logger(level, {
    ...options,
    color: false,
    destination: { write: (line) => lines.push(line) },
  });
  return { logger, lines };
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  assert.ok(line !== undefined);
  return line;
}

test("development feed keeps messages and error summaries on one safe line", () => {
  const { logger, lines } = capture("info", { format: "dev" });
  logger.info(
    "session.wake",
    { channelId: "123" },
    "Woke in #general\nafter a ping\r\t\u0008\u000c\u001b\u2028\u2029",
  );
  logger.warn(
    "tasks.completion_failed",
    { error: new Error("permission\ndenied") },
    "Couldn’t save task completion",
  );
  assert.equal(lines.length, 2);
  assert.match(
    lineAt(lines, 0),
    /^\d{2}:\d{2}:\d{2} {2}session\s+Woke in #general\\nafter a ping\\r\\t\\u0008\\u000c\\u001b\\u2028\\u2029\n$/,
  );
  assert.match(lineAt(lines, 1), /WARN\s+Couldn’t save task completion: permission\\ndenied\n$/);
  assert.equal(lineAt(lines, 1).split("\n").length, 2);
  assert.doesNotMatch(lines.join(""), /channelId|123| at /);
});

test("threshold filtering applies to both outputs", () => {
  for (const format of ["dev", "json"] as const) {
    const { logger, lines } = capture("warn", { format });
    logger.debug("session.debug");
    logger.info("session.info");
    logger.warn("session.warn");
    logger.error("session.error");
    assert.equal(lines.length, 2);
  }
});

test("development stacks appear only at debug threshold", () => {
  const error = new Error("failed");
  error.stack = "Error: failed\n    at isolated-test";
  for (const level of ["info", "debug"] as const) {
    const { logger, lines } = capture(level, { format: "dev" });
    logger.warn("conversation.failed", { error }, "Conversation failed");
    assert.equal(lineAt(lines, 0).includes("    at isolated-test"), level === "debug");
  }
});

test("JSON retains event, fields, error stack, cause, and custom properties", () => {
  const error = Object.assign(
    new Error("permission denied", { cause: new Error("disk unavailable") }),
    { code: "EACCES" },
  );
  for (const level of ["info", "debug"] as const) {
    const { logger, lines } = capture(level, { format: "json" });
    logger.warn(
      "tasks.completion_failed",
      { id: "task-1", channelId: "123", error },
      "Couldn’t save task completion",
    );
    const record = JSON.parse(lineAt(lines, 0)) as Record<string, unknown>;
    assert.equal(record.event, "tasks.completion_failed");
    assert.equal(record.id, "task-1");
    assert.equal(record.channelId, "123");
    assert.equal(record.msg, "Couldn’t save task completion");
    assert.deepEqual(record.error, {
      type: "Error",
      message: error.message,
      stack: error.stack,
      cause: { type: "Error", message: "disk unavailable", stack: (error.cause as Error).stack },
      code: "EACCES",
    });
  }
});

test("non-Error failures render safely", () => {
  for (const error of [
    null,
    "failed\nagain",
    { message: "object failure" },
    { detail: "unknown failure" },
    7,
  ]) {
    const { logger, lines } = capture("debug", { format: "dev" });
    assert.doesNotThrow(() => logger.error("discord.error", { error }, "Discord failed"));
    assert.equal(lineAt(lines, 0).split("\n").length, 2);
    assert.match(lineAt(lines, 0), /ERROR\s+Discord failed:/);
  }
});

test("output defaults follow NODE_ENV and explicit format overrides it", () => {
  const previous = process.env.NODE_ENV;
  try {
    for (const environment of [undefined, "production", "development"]) {
      if (environment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = environment;
      const { logger, lines } = capture();
      logger.info("session.wake", undefined, "Woke");
      assert.equal(lineAt(lines, 0).startsWith("{"), environment !== "development");
    }
    const { logger, lines } = capture("info", { format: "json" });
    logger.info("session.wake");
    assert.equal(JSON.parse(lineAt(lines, 0)).event, "session.wake");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("explicit terminal color affects only the feed layout", () => {
  const lines: string[] = [];
  new Logger("info", {
    format: "dev",
    color: true,
    destination: { write: (line) => lines.push(line) },
  }).warn("tasks.failed", undefined, "Failed");
  assert.ok(lineAt(lines, 0).includes("\u001b[33mWARN"));
});

test("normal component labels keep the message column aligned", () => {
  const { logger, lines } = capture("info", { format: "dev" });
  for (const event of [
    "session.wake",
    "conversation.reply",
    "memory_consolidation.consolidated",
    "known_people.read",
  ])
    logger.info(event, undefined, "Activity");
  assert.deepEqual(
    lines.map((line) => line.indexOf("Activity")),
    [20, 20, 20, 20],
  );
});
