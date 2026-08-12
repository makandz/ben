import assert from "node:assert/strict";
import test from "node:test";

import {
  DREAM_COMPLETE_MESSAGE,
  DREAM_START_MESSAGE,
  handleConsolidateCommand,
  registerConsolidateCommand,
} from "../consolidateCommand.js";
import type { DiscordCommandEvent } from "../DiscordGateway.js";
import type { ManualConsolidationOutcome } from "../../memory/MemoryConsolidationScheduler.js";

const quietLogger = {
  info() {},
  warn() {},
};

const quietSender = async (): Promise<void> => {};

test("registers the global consolidate command", async () => {
  const commands: unknown[] = [];
  await registerConsolidateCommand(
    {
      async registerCommand(command) {
        commands.push(command);
        return "registered";
      },
    },
    quietLogger,
  );

  assert.deepEqual(commands, [
    { name: "consolidate", description: "Consolidate Ben's short-term memories." },
  ]);
});

test("rejects missing configuration and unauthorized users ephemerally", async () => {
  const disabled = recordingInteraction("admin");
  const unauthorized = recordingInteraction("someone-else");
  const scheduler = scriptedScheduler("consolidated");

  await handleConsolidateCommand(disabled.event, undefined, scheduler, quietSender, quietLogger);
  await handleConsolidateCommand(unauthorized.event, "admin", scheduler, quietSender, quietLogger);

  assert.deepEqual(disabled.replies, [
    { content: "Consolidation is not configured.", ephemeral: true },
  ]);
  assert.deepEqual(unauthorized.replies, [
    { content: "Only the configured bot admin can run this command.", ephemeral: true },
  ]);
  assert.equal(scheduler.calls, 0);
});

test("shows the chosen dream start and completion messages", async () => {
  const interaction = recordingInteraction("admin");
  const channelMessages: Array<{ channelId: string; message: string }> = [];
  const scheduler = {
    async consolidateNow(reporter: {
      started(): Promise<void>;
      completed(result: {
        conversationSummaries: number;
        shortTermMemories: number;
      }): Promise<void>;
    }) {
      await reporter.started();
      await reporter.completed({ conversationSummaries: 3, shortTermMemories: 2 });
      return "consolidated" as const;
    },
  };

  await handleConsolidateCommand(
    interaction.event,
    "admin",
    scheduler,
    async (channelId, message) => {
      channelMessages.push({ channelId, message });
    },
    quietLogger,
  );

  assert.deepEqual(interaction.replies, [DREAM_START_MESSAGE]);
  assert.deepEqual(channelMessages, [
    {
      channelId: "channel-1",
      message: "> Cleared 3 conversation summaries and 2 short-term memories.",
    },
    { channelId: "channel-1", message: DREAM_COMPLETE_MESSAGE },
  ]);
});

test("reports empty, active, and already-running manual requests", async () => {
  const cases = [
    ["empty", "Nothing to consolidate."],
    ["active", "> ⚠️ Ben is awake right now. Try again when the conversation is finished."],
    ["running", "Consolidation is already running."],
  ] as const;

  for (const [outcome, expected] of cases) {
    const interaction = recordingInteraction("admin");
    await handleConsolidateCommand(
      interaction.event,
      "admin",
      scriptedScheduler(outcome),
      quietSender,
      quietLogger,
    );
    assert.deepEqual(interaction.replies, [expected]);
  }
});

function recordingInteraction(userId: string): {
  event: DiscordCommandEvent;
  replies: Array<string | { content: string; ephemeral: boolean }>;
} {
  const replies: Array<string | { content: string; ephemeral: boolean }> = [];
  return {
    event: {
      name: "consolidate",
      userId,
      channelId: "channel-1",
      async reply(content) {
        replies.push(content);
      },
    },
    replies,
  };
}

function scriptedScheduler(outcome: ManualConsolidationOutcome): {
  calls: number;
  consolidateNow(): Promise<ManualConsolidationOutcome>;
} {
  return {
    calls: 0,
    async consolidateNow() {
      this.calls += 1;
      return outcome;
    },
  };
}
