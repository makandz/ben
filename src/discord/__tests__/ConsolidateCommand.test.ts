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

  await handleConsolidateCommand(disabled.event, undefined, scheduler, quietLogger);
  await handleConsolidateCommand(unauthorized.event, "admin", scheduler, quietLogger);

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
  const scheduler = {
    async consolidateNow(reporter: { started(): Promise<void>; completed(): Promise<void> }) {
      await reporter.started();
      await reporter.completed();
      return "consolidated" as const;
    },
  };

  await handleConsolidateCommand(interaction.event, "admin", scheduler, quietLogger);

  assert.deepEqual(interaction.replies, [DREAM_START_MESSAGE]);
  assert.deepEqual(interaction.followUps, [DREAM_COMPLETE_MESSAGE]);
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
      quietLogger,
    );
    assert.deepEqual(interaction.replies, [expected]);
  }
});

function recordingInteraction(userId: string): {
  event: DiscordCommandEvent;
  replies: Array<string | { content: string; ephemeral: boolean }>;
  followUps: Array<string | { content: string; ephemeral: boolean }>;
} {
  const replies: Array<string | { content: string; ephemeral: boolean }> = [];
  const followUps: Array<string | { content: string; ephemeral: boolean }> = [];
  return {
    event: {
      name: "consolidate",
      userId,
      channelId: "channel-1",
      async reply(content) {
        replies.push(content);
      },
      async followUp(content) {
        followUps.push(content);
      },
    },
    replies,
    followUps,
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
