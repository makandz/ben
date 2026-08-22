import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore, type AutonomousTask } from "../../storage/TaskStore.js";
import type { Tool } from "../../tools/Tool.js";
import { ChannelMentionDirectory } from "../DiscordDirectory.js";
import type {
  DiscordChannel,
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordMember,
  DiscordSendOptions,
  DiscordUser,
} from "../DiscordGateway.js";
import {
  createCreateTaskTool,
  createDeleteTaskTool,
  createEditTaskTool,
  createViewTasksTool,
  type TaskToolDependencies,
} from "../tools/tasks.js";

const general: DiscordChannel = { id: "general-id", name: "general", guildId: "guild" };
const plans: DiscordChannel = { id: "plans-id", name: "plans", guildId: "guild" };
const own: DiscordChannel = { id: "own-id", name: "ben-logs", guildId: "guild" };

test("task tools create current, named, and own-channel tasks after viewing", async (t) => {
  const fixture = await createFixture(t);
  const { gateway, view, create } = fixture;

  assert.deepEqual(await execute(view, {}), {
    type: "continue",
    result: { ok: true, revision: 0, tasks: [] },
  });
  assert.equal(gateway.sent.at(-1)?.content, "> Ben is viewing 0 tasks.");

  const current = await execute(create, taskArguments(0, "Current check", "current"));
  assert.equal(readTask(current).destination.kind, "current");
  assert.equal(readTask(current).destination.channelId, "general-id");
  assert.equal(
    gateway.sent.at(-1)?.content,
    '> Ben created task "Current check" to run Saturday at 12:00 PM in #general.',
  );

  const viewed = await execute(view, {});
  const viewResult = readResult(viewed) as { revision: number; tasks: unknown[] };
  assert.equal(viewResult.revision, 1);
  assert.equal(viewResult.tasks.length, 1);
  assert.match(JSON.stringify(viewResult.tasks), /Detailed instructions/);
  assert.match(JSON.stringify(viewResult.tasks), /task_/);
  assert.equal(gateway.sent.at(-1)?.content, "> Ben is viewing 1 task.");
  assert.doesNotMatch(gateway.sent.at(-1)?.content ?? "", /Detailed|task_/);
  const named = await execute(create, taskArguments(1, "Plans check", "#plans"));
  assert.deepEqual(readTask(named).destination, {
    kind: "named",
    channelId: "plans-id",
    channelName: "plans",
  });
  assert.equal(
    gateway.sent.at(-1)?.content,
    '> Ben created task "Plans check" to run Saturday at 12:00 PM in #plans.',
  );

  await execute(view, {});
  const privateTask = await execute(create, taskArguments(2, "Private check", null));
  assert.deepEqual(readTask(privateTask).destination, {
    kind: "own",
    channelId: "own-id",
    channelName: "ben-logs",
  });
  assert.equal(
    gateway.sent.at(-1)?.content,
    '> Ben created task "Private check" to run Saturday at 12:00 PM in his own channel.',
  );
  assert.deepEqual(gateway.sent.at(-1)?.options, { allowUserMentions: false });
});

test("task tools fully replace, rename, and permanently delete tasks", async (t) => {
  const { gateway, view, create, edit, remove } = await createFixture(t);
  await execute(view, {});
  const created = await execute(create, taskArguments(0, "Old title", "current"));
  const id = readTask(created).id;
  await execute(view, {});
  const edited = await execute(edit, {
    ...taskArguments(1, "New title", "#plans"),
    task_id: id,
    description: "Replacement description",
    instructions: "Replacement detailed instructions.",
  });
  assert.equal(readTask(edited).createdAt, readTask(created).createdAt);
  assert.equal(readTask(edited).description, "Replacement description");
  assert.equal(
    gateway.sent.at(-1)?.content,
    '> Ben updated his task "Old title" to "New title". Next run: Saturday at 12:00 PM in #plans.',
  );

  const deleted = await execute(remove, { task_id: id });
  assert.equal(readTask(deleted).name, "New title");
  assert.equal(gateway.sent.at(-1)?.content, '> Ben deleted his task "New title".');
  const viewed = await execute(view, {});
  assert.deepEqual((readResult(viewed) as { tasks: unknown[] }).tasks, []);
});

test("task tools visibly reject stale revisions, duplicate names, and invalid schedules", async (t) => {
  const { gateway, view, create, edit } = await createFixture(t);
  await execute(view, {});
  const first = await execute(create, taskArguments(0, "First", "current"));
  const stale = await execute(create, taskArguments(0, "Stale", "current"));
  assert.match(JSON.stringify(stale), /run view_tasks again/);
  assert.match(gateway.sent.at(-1)?.content ?? "", /^> ⚠️ Ben couldn't create task "Stale":/);

  await execute(view, {});
  const duplicate = await execute(create, taskArguments(1, " first ", "current"));
  assert.match(JSON.stringify(duplicate), /already exists/);
  assert.match(gateway.sent.at(-1)?.content ?? "", /^> ⚠️/);

  await execute(view, {});
  const invalidDate = await execute(edit, {
    ...taskArguments(1, "First", "current"),
    task_id: readTask(first).id,
    run_date: "2026-02-30",
  });
  assert.match(JSON.stringify(invalidDate), /run_date must be YYYY-MM-DD/);
  assert.match(gateway.sent.at(-1)?.content ?? "", /^> ⚠️ Ben couldn't update his task "First":/);

  const past = await execute(create, {
    ...taskArguments(1, "Past", "current"),
    run_date: "2026-08-20",
  });
  assert.match(JSON.stringify(past), /must be in the future/);
});

test("task tools reject unavailable channel destinations without requiring a creator", async (t) => {
  const fixture = await createFixture(t);
  await execute(fixture.view, {});
  const missing = await execute(fixture.create, taskArguments(0, "Missing", "#unknown"));
  assert.match(JSON.stringify(missing), /was not found uniquely/);
  assert.equal(fixture.gateway.sent.at(-1)?.channelId, "general-id");
  assert.match(fixture.gateway.sent.at(-1)?.content ?? "", /^> ⚠️/);
});

test("live task tools expose and accept daily and weekly recurrence", async (t) => {
  const fixture = await createFixture(t);
  await execute(fixture.view, {});
  const daily = await execute(fixture.create, taskArguments(0, "Daily review", "current", "daily"));
  assert.equal(readTask(daily).repeat, "daily");
  assert.equal(
    fixture.gateway.sent.at(-1)?.content,
    '> Ben created task "Daily review" to run every day at 12:00 PM in #general.',
  );

  await execute(fixture.view, {});
  const weekly = await execute(fixture.create, taskArguments(1, "Weekly review", null, "weekly"));
  assert.equal(readTask(weekly).repeat, "weekly");
  assert.equal(
    fixture.gateway.sent.at(-1)?.content,
    '> Ben created task "Weekly review" to run every Saturday at 12:00 PM in his own channel.',
  );

  await execute(fixture.view, {});
  const edited = await execute(fixture.edit, {
    ...taskArguments(2, "Daily review", "current", "weekly"),
    task_id: readTask(daily).id,
  });
  assert.equal(readTask(edited).repeat, "weekly");
  assert.equal(
    fixture.gateway.sent.at(-1)?.content,
    '> Ben updated his task "Daily review". Next run: Saturday at 12:00 PM in #general.',
  );

  await execute(fixture.view, {});
  const invalid = await execute(fixture.create, taskArguments(3, "Invalid", "current", "monthly"));
  assert.match(JSON.stringify(invalid), /repeat must be none, daily, or weekly/);
});

async function createFixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-task-tools-"));
  t.after(() => rm(directory, { recursive: true }));
  const gateway = new FakeGateway();
  const dependencies: TaskToolDependencies = {
    gateway,
    channels: new ChannelMentionDirectory(),
    store: new TaskStore(path.join(directory, "tasks.json"), { warn() {} }),
    getActiveChannelId: () => general.id,
    getOwnChannelId: () => own.id,
    logger: { warn() {} },
    timeZone: "America/Toronto",
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  };
  return {
    gateway,
    view: createViewTasksTool(dependencies),
    create: createCreateTaskTool(dependencies),
    edit: createEditTaskTool(dependencies),
    remove: createDeleteTaskTool(dependencies),
  };
}

function taskArguments(revision: number, name: string, channel: string | null, repeat = "none") {
  return {
    revision,
    name,
    description: "Short summary",
    instructions: "Detailed instructions Ben wrote for himself.",
    channel,
    run_date: "2026-08-22",
    run_time: "12:00",
    repeat,
  };
}

async function execute(tool: Tool, argumentsValue: unknown) {
  return tool.execute({
    type: "tool_call",
    callId: "call",
    name: tool.definition.name,
    arguments: argumentsValue,
  });
}

function readResult(value: Awaited<ReturnType<typeof execute>>): unknown {
  return value.result;
}

function readTask(value: Awaited<ReturnType<typeof execute>>) {
  const result = readResult(value) as { task: AutonomousTask };
  return result.task;
}

class FakeGateway implements DiscordGateway {
  channels = [general, plans, own];
  sent: Array<{ channelId: string; content: string; options: DiscordSendOptions }> = [];

  setHandlers(_handlers: DiscordGatewayHandlers): void {}
  async login(_token: string): Promise<void> {}
  async destroy(): Promise<void> {}
  getBotUser(): DiscordUser | undefined {
    return undefined;
  }
  async fetchChannel(channelId: string): Promise<DiscordChannel | undefined> {
    return this.channels.find((channel) => channel.id === channelId);
  }
  async searchGuildMembers(): Promise<readonly DiscordMember[]> {
    return [];
  }
  async fetchGuildChannels(): Promise<readonly DiscordChannel[]> {
    return this.channels;
  }
  async sendMessage(channelId: string, content: string, options: DiscordSendOptions) {
    this.sent.push({ channelId, content, options });
    return { id: `sent-${String(this.sent.length)}`, createdAt: this.sent.length };
  }
  async addReaction(_channelId: string, _messageId: string, _emoji: string): Promise<void> {}
  async sendTyping(_channelId: string): Promise<void> {}
  setPresence(_status: "idle" | "online"): void {}
  setCustomStatus(_content: string | undefined): void {}
  async registerCommand(): Promise<"registered"> {
    return "registered";
  }
}
