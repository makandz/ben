import type { ChatInputCommandInteraction, Client } from "discord.js";

import type { Logger } from "../logger.js";
import type { OpenAIUsageStore, UsageSummary } from "../openai/usageStore.js";

const usageCommand = {
  name: "usage",
  description: "Show today's OpenAI token usage and estimated cost.",
};

export async function registerUsageCommand(
  client: Client,
  logger: Logger,
): Promise<void> {
  const commands = await client.application?.commands.fetch();
  const existing = commands?.find((command) => command.name === usageCommand.name);

  if (existing === undefined) {
    await client.application?.commands.create(usageCommand);
    logger.info("discord.command_registered", {
      command: usageCommand.name,
      scope: "global",
    });
    return;
  }

  await existing.edit(usageCommand);
  logger.info("discord.command_updated", {
    command: usageCommand.name,
    scope: "global",
  });
}

export async function handleUsageCommand(
  interaction: ChatInputCommandInteraction,
  usageStore: OpenAIUsageStore,
  logger: Logger,
): Promise<void> {
  try {
    const summary = await usageStore.getTodaySummary();
    await interaction.reply(formatUsageSummary(summary));
  } catch (error) {
    logger.warn("discord.usage_command_failed", { error: String(error) });
    await interaction.reply({
      content: "Could not read usage right now.",
      ephemeral: true,
    });
  }
}

function formatUsageSummary(summary: UsageSummary): string {
  return `${formatInteger(summary.inputTokens)}/${formatInteger(summary.cachedInputTokens)}/${formatInteger(summary.outputTokens)} (input/cached/output) - ${formatUsd(summary.costUsd)} (${formatUsagePercent(summary)}) - ${summary.model}`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsagePercent(summary: UsageSummary): string {
  if (summary.budgetUsd <= 0) {
    return "n/a";
  }

  return `${((summary.costUsd / summary.budgetUsd) * 100).toFixed(1)}%`;
}
