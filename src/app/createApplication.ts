import type { AppEnv } from "../env.js";
import type { Logger } from "../logger.js";
import { ConversationOrchestrator } from "./ConversationOrchestrator.js";
import { BotSession } from "./BotSession.js";
import { DiscordAdapter } from "../discord/DiscordAdapter.js";
import { ChannelMentionDirectory, UserMentionDirectory } from "../discord/DiscordDirectory.js";
import type { DiscordGateway } from "../discord/DiscordGateway.js";
import { DiscordPresence } from "../discord/DiscordPresence.js";
import { DiscordTransport } from "../discord/DiscordTransport.js";
import {
  DREAM_COMPLETE_MESSAGE,
  DREAM_START_MESSAGE,
  formatConsolidationResult,
  handleConsolidateCommand,
  registerConsolidateCommand,
} from "../discord/consolidateCommand.js";
import { handleUsageCommand, registerUsageCommand } from "../discord/usageCommand.js";
import {
  createCreateTaskTool,
  createDeleteTaskTool,
  createEditTaskTool,
  createViewTasksTool,
} from "../discord/tools/tasks.js";
import { createRememberNameTool } from "../discord/tools/rememberName.js";
import { createReactToMessageTool } from "../discord/tools/reactToMessage.js";
import { createSendMessageTool } from "../discord/tools/sendChannelMessage.js";
import { sendToolStatus } from "../discord/tools/toolSupport.js";
import { createThinkTool } from "../discord/tools/think.js";
import { createUpdateCustomStatusTool } from "../discord/tools/updateCustomStatus.js";
import type { Model } from "../model/Model.js";
import { MemoryConsolidationScheduler } from "../memory/MemoryConsolidationScheduler.js";
import { MemoryConsolidator } from "../memory/MemoryConsolidator.js";
import { OpenAIUsageStore } from "../model/openai/OpenAIUsageStore.js";
import { formatBotTime, SCHEDULE_TIME_ZONE } from "../scheduling/scheduleTime.js";
import { ConversationSummaryStore } from "../storage/ConversationSummaryStore.js";
import { CustomStatusStore } from "../storage/CustomStatusStore.js";
import { KnownPeopleStore } from "../storage/KnownPeopleStore.js";
import { MemoryStore } from "../storage/MemoryStore.js";
import { LongTermMemoryStore } from "../storage/LongTermMemoryStore.js";
import { MemoryConsolidationStateStore } from "../storage/MemoryConsolidationStateStore.js";
import { TaskStore } from "../storage/TaskStore.js";
import { TaskScheduler } from "../scheduling/TaskScheduler.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { sleepTool, waitTool } from "../tools/conversationControls.js";
import { createRememberTool } from "../tools/remember.js";

const paths = {
  summaries: "logs/conversation-summaries.json",
  people: "logs/known-people.json",
  tasks: "logs/tasks.json",
  customStatus: "logs/custom-status.json",
  memories: "logs/memories.json",
  longTermMemory: "logs/long-term-memory.txt",
  memoryConsolidationState: "logs/memory-consolidation.json",
} as const;

export type Application = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type ApplicationDependencies = {
  env: AppEnv;
  logger: Logger;
  gateway: DiscordGateway;
  conversationModel: Model;
  consolidationModel: Model;
  instructions: string;
  consolidationInstructions: string;
  usageStore: OpenAIUsageStore;
};

/**
 * Composes the replacement application without logging in or starting timers.
 *
 * @param dependencies - Runtime configuration and owned boundary implementations.
 * @returns A start/stop application lifecycle.
 */
export function createApplication(dependencies: ApplicationDependencies): Application {
  const { env, logger, gateway } = dependencies;
  const users = new UserMentionDirectory();
  const channels = new ChannelMentionDirectory();
  let session!: BotSession;
  const transport = new DiscordTransport(
    gateway,
    users,
    channels,
    env.discordLogChannelId,
    logger,
    (channelId, text, delivery) => {
      const botUser = gateway.getBotUser();
      session.recordBotMessage({
        id: delivery.id,
        channelId,
        userId: botUser?.id ?? "ben",
        username: botUser?.username ?? "Ben",
        content: text,
        createdAt: delivery.createdAt,
      });
    },
  );
  const presence = new DiscordPresence(gateway);
  const summaries = new ConversationSummaryStore(paths.summaries, logger);
  const people = new KnownPeopleStore(paths.people, logger);
  const tasks = new TaskStore(paths.tasks, logger);
  const customStatus = new CustomStatusStore(paths.customStatus, logger);
  const memories = new MemoryStore(paths.memories, logger);
  const longTermMemory = new LongTermMemoryStore(paths.longTermMemory);
  const consolidationState = new MemoryConsolidationStateStore(
    paths.memoryConsolidationState,
    logger,
  );
  const tools = new ToolRegistry([waitTool, sleepTool]);
  tools.register(
    createRememberTool({
      store: memories,
      sendStatus: (message) =>
        sendToolStatus(
          gateway,
          logger,
          "discord.memory_status_failed",
          session.getActiveChannelId(),
          message,
        ),
    }),
  );
  tools.register(
    createSendMessageTool({
      transport,
      getActiveChannelId: () => session.getActiveChannelId(),
      isMessageInActiveConversation: (messageId) =>
        session.isMessageInActiveConversation(messageId),
    }),
  );
  tools.register(
    createThinkTool({
      transport,
      getActiveChannelId: () => session.getActiveChannelId(),
    }),
  );
  tools.register(
    createReactToMessageTool({
      gateway,
      getActiveChannelId: () => session.getActiveChannelId(),
      isMessageInActiveConversation: (messageId) =>
        session.isMessageInActiveConversation(messageId),
    }),
  );
  tools.register(
    createRememberNameTool({
      gateway,
      users,
      store: people,
      getActiveChannelId: () => session.getActiveChannelId(),
      logger,
    }),
  );
  tools.register(
    createUpdateCustomStatusTool({
      gateway,
      store: customStatus,
      getActiveChannelId: () => session.getActiveChannelId(),
      logger,
    }),
  );
  const taskToolDependencies = {
    gateway,
    channels,
    store: tasks,
    getActiveChannelId: () => session.getActiveChannelId(),
    getOwnChannelId: () => env.discordLogChannelId,
    logger,
  };
  tools.register(createViewTasksTool(taskToolDependencies));
  tools.register(createCreateTaskTool(taskToolDependencies));
  tools.register(createEditTaskTool(taskToolDependencies));
  tools.register(createDeleteTaskTool(taskToolDependencies));
  session = new BotSession(
    dependencies.instructions,
    new ConversationOrchestrator(dependencies.conversationModel, tools),
    transport,
    presence,
    logger,
    {},
    { summaries, knownPeople: people, customStatus, memories, longTermMemory },
    {
      getCurrentBotTime: () => formatBotTime(new Date(), SCHEDULE_TIME_ZONE),
    },
  );
  const taskScheduler = new TaskScheduler(
    tasks,
    (task, complete) => session.enqueueTask(task, complete),
    logger,
  );
  const memoryConsolidator = new MemoryConsolidator(
    dependencies.consolidationModel,
    dependencies.consolidationInstructions,
    { summaries, shortTermMemories: memories, longTermMemory },
  );
  const memoryConsolidationScheduler = new MemoryConsolidationScheduler(
    memoryConsolidator,
    consolidationState,
    session,
    {
      started: () => sendConsolidationStatus(transport, logger, DREAM_START_MESSAGE),
      completed: async (result) => {
        await sendConsolidationStatus(transport, logger, formatConsolidationResult(result));
        await sendConsolidationStatus(transport, logger, DREAM_COMPLETE_MESSAGE);
      },
      failed: () =>
        sendConsolidationStatus(
          transport,
          logger,
          "Consolidation failed. Short-term memories were preserved.",
        ),
    },
    logger,
  );

  let ready = false;
  let restoredCustomStatus: string | undefined;
  const adapter = new DiscordAdapter(
    gateway,
    {
      handleMessage: (message, pinged) => session.handleMessage(message, pinged),
      handleTyping: (channelId, userId, username) =>
        session.handleTyping(channelId, userId, username),
      handleReady: () => {
        if (ready) return;
        ready = true;
        presence.setPresence({ status: "idle" });
        try {
          gateway.setCustomStatus(restoredCustomStatus);
        } catch (error) {
          logger.warn("discord.custom_status_restore_failed", { error: String(error) });
        }
        void taskScheduler.start();
        void memoryConsolidationScheduler.start();
        void registerUsageCommand(gateway, logger).catch((error: unknown) => {
          logger.warn("discord.command_registration_failed", { error: String(error) });
        });
        void registerConsolidateCommand(gateway, logger).catch((error: unknown) => {
          logger.warn("discord.command_registration_failed", { error: String(error) });
        });
      },
      handleCommand: (event) => {
        if (event.name === "usage") {
          void handleUsageCommand(event, dependencies.usageStore, logger);
        } else if (event.name === "consolidate") {
          void handleConsolidateCommand(
            event,
            env.discordAdminUserId,
            memoryConsolidationScheduler,
            async (channelId, message) => {
              await transport.sendMessage(channelId, message);
            },
            logger,
          );
        }
      },
    },
    users,
    channels,
    logger,
  );

  return {
    async start() {
      restoredCustomStatus = await customStatus.get();
      await adapter.start(env.discordToken);
    },
    async stop() {
      session.stop();
      taskScheduler.stop();
      memoryConsolidationScheduler.stop();
      await adapter.stop();
    },
  };
}

/** Contains optional Discord consolidation-status delivery failures. */
async function sendConsolidationStatus(
  transport: Pick<DiscordTransport, "logStatus">,
  logger: Pick<Logger, "warn">,
  message: string,
): Promise<void> {
  await transport.logStatus(message).catch((error: unknown) => {
    logger.warn("discord.memory_consolidation_status_failed", { error: String(error) });
  });
}
