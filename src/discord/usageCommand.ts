import type { Logger } from "../logger.js";
import type { OpenAIUsageStore, UsageSummary } from "../model/openai/OpenAIUsageStore.js";
import { formatUsd } from "../util/formatCurrency.js";
import type { DiscordCommandEvent, DiscordGateway } from "./DiscordGateway.js";

export const usageCommand = {
  name: "usage",
  description: "Show today's OpenAI token usage and estimated cost.",
} as const;

/**
 * Registers or refreshes the global usage command.
 *
 * @param gateway - Discord command-registration boundary.
 * @param logger - Logger for the resulting registration action.
 * @returns A promise that resolves after Discord accepts the command.
 */
export async function registerUsageCommand(
  gateway: Pick<DiscordGateway, "registerCommand">,
  logger: Pick<Logger, "info">,
): Promise<void> {
  const action = await gateway.registerCommand(usageCommand);
  logger.info(`discord.command_${action}`, { command: usageCommand.name, scope: "global" });
}

/**
 * Replies to one normalized usage command without exposing Discord SDK types.
 *
 * @param interaction - Normalized reply capability.
 * @param usageStore - Daily usage summary source.
 * @param logger - Logger for contained read failures.
 * @returns A promise that resolves after the interaction reply.
 */
export async function handleUsageCommand(
  interaction: Pick<DiscordCommandEvent, "reply">,
  usageStore: Pick<OpenAIUsageStore, "getTodaySummary">,
  logger: Pick<Logger, "warn">,
): Promise<void> {
  try {
    await interaction.reply(formatUsageSummary(await usageStore.getTodaySummary()));
  } catch (error) {
    logger.warn("discord.usage_command_failed", { error: String(error) });
    await interaction.reply({ content: "Could not read usage right now.", ephemeral: true });
  }
}

/**
 * Formats the production-compatible compact daily usage line.
 *
 * @param summary - Aggregated daily token, cost, model, and budget values.
 * @returns Compact user-facing usage text.
 */
export function formatUsageSummary(summary: UsageSummary): string {
  const uncachedInputTokens = Math.max(0, summary.inputTokens - summary.cachedInputTokens);
  return `${formatInteger(uncachedInputTokens)}/${formatInteger(summary.cachedInputTokens)}/${formatInteger(summary.outputTokens)} (uncached/cached/output) - ${formatUsd(summary.costUsd)} (${formatUsagePercent(summary)}) - ${summary.model}`;
}

/** Formats an integer with locale-appropriate grouping separators. */
function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** Formats the share of the daily budget consumed, or `n/a` when budgeting is disabled. */
function formatUsagePercent(summary: UsageSummary): string {
  return summary.budgetUsd <= 0
    ? "n/a"
    : `${((summary.costUsd / summary.budgetUsd) * 100).toFixed(1)}%`;
}
