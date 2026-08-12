import type { Logger } from "../logger.js";
import type { MemoryConsolidationScheduler } from "../memory/MemoryConsolidationScheduler.js";
import type { DiscordCommandEvent, DiscordGateway } from "./DiscordGateway.js";

export const DREAM_START_MESSAGE = "> 🌙 Ben is dreaming...";
export const DREAM_COMPLETE_MESSAGE = "> ☀️ Ben woke up.";

export const consolidateCommand = {
  name: "consolidate",
  description: "Consolidate Ben's short-term memories.",
} as const;

/**
 * Registers or refreshes the global memory consolidation command.
 *
 * @param gateway - Discord command-registration boundary.
 * @param logger - Logger for the resulting registration action.
 * @returns A promise that resolves after Discord accepts the command.
 */
export async function registerConsolidateCommand(
  gateway: Pick<DiscordGateway, "registerCommand">,
  logger: Pick<Logger, "info">,
): Promise<void> {
  const action = await gateway.registerCommand(consolidateCommand);
  logger.info(`discord.command_${action}`, { command: consolidateCommand.name, scope: "global" });
}

/**
 * Authorizes and runs one manual memory consolidation request.
 *
 * @param interaction - Normalized Discord interaction and response capabilities.
 * @param adminUserId - Sole configured user allowed to invoke consolidation.
 * @param scheduler - Shared non-overlapping consolidation coordinator.
 * @param logger - Logger for contained command failures.
 * @returns A promise that resolves after the command's final response is sent.
 */
export async function handleConsolidateCommand(
  interaction: DiscordCommandEvent,
  adminUserId: string | undefined,
  scheduler: Pick<MemoryConsolidationScheduler, "consolidateNow">,
  logger: Pick<Logger, "warn">,
): Promise<void> {
  if (adminUserId === undefined) {
    await interaction.reply({
      content: "Consolidation is not configured.",
      ephemeral: true,
    });
    return;
  }
  if (interaction.userId !== adminUserId) {
    await interaction.reply({
      content: "Only the configured bot admin can run this command.",
      ephemeral: true,
    });
    return;
  }

  let started = false;
  try {
    const outcome = await scheduler.consolidateNow({
      async started() {
        started = true;
        await interaction.reply(DREAM_START_MESSAGE);
      },
      async completed() {
        await interaction.followUp(DREAM_COMPLETE_MESSAGE);
      },
      async failed() {
        const content = "Consolidation failed. Short-term memories were preserved.";
        if (started) await interaction.followUp(content);
        else await interaction.reply(content);
      },
    });

    if (outcome === "empty") {
      await interaction.reply("Nothing to consolidate.");
    } else if (outcome === "active") {
      await interaction.reply(
        "> ⚠️ Ben is awake right now. Try again when the conversation is finished.",
      );
    } else if (outcome === "running") {
      await interaction.reply("Consolidation is already running.");
    }
  } catch (error) {
    logger.warn("discord.consolidate_command_failed", { error: String(error) });
  }
}
