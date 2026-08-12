import type { AppEnv } from "../env.js";
import type { Logger } from "../logger.js";
import { ConversationOrchestrator } from "./ConversationOrchestrator.js";
import { BotSession } from "./BotSession.js";
import { DiscordAdapter } from "../discord/DiscordAdapter.js";
import { ChannelMentionDirectory, UserMentionDirectory } from "../discord/DiscordDirectory.js";
import type { DiscordGateway } from "../discord/DiscordGateway.js";
import { DiscordPresence } from "../discord/DiscordPresence.js";
import { createScheduledMessageDelivery } from "../discord/ScheduledMessageDelivery.js";
import { DiscordTransport } from "../discord/DiscordTransport.js";
import { handleUsageCommand, registerUsageCommand } from "../discord/usageCommand.js";
import { createScheduledMessageTool } from "../discord/tools/createScheduledMessage.js";
import { createRememberNameTool } from "../discord/tools/rememberName.js";
import { createReactToMessageTool } from "../discord/tools/reactToMessage.js";
import { createSendMessageTool } from "../discord/tools/sendChannelMessage.js";
import { sendToolStatus } from "../discord/tools/toolSupport.js";
import { createUpdateCustomStatusTool } from "../discord/tools/updateCustomStatus.js";
import type { Model } from "../model/Model.js";
import { MemoryConsolidationScheduler } from "../memory/MemoryConsolidationScheduler.js";
import { MemoryConsolidator } from "../memory/MemoryConsolidator.js";
import { OpenAIUsageStore } from "../model/openai/OpenAIUsageStore.js";
import { formatBotTime } from "../scheduling/scheduleTime.js";
import {
  ScheduledMessageScheduler,
  SCHEDULE_TIME_ZONE,
} from "../scheduling/ScheduledMessageScheduler.js";
import { ConversationSummaryStore } from "../storage/ConversationSummaryStore.js";
import { CustomStatusStore } from "../storage/CustomStatusStore.js";
import { KnownPeopleStore } from "../storage/KnownPeopleStore.js";
import { MemoryStore } from "../storage/MemoryStore.js";
import { LongTermMemoryStore } from "../storage/LongTermMemoryStore.js";
import { MemoryConsolidationStateStore } from "../storage/MemoryConsolidationStateStore.js";
import { ScheduledMessageStore } from "../storage/ScheduledMessageStore.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { sleepTool, waitTool } from "../tools/conversationControls.js";
import { createRememberTool } from "../tools/remember.js";

const paths = {
  summaries: "logs/conversation-summaries.json",
  people: "logs/known-people.json",
  schedules: "logs/scheduled-messages.json",
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
  const schedules = new ScheduledMessageStore(paths.schedules, logger);
  const customStatus = new CustomStatusStore(paths.customStatus, logger);
  const memories = new MemoryStore(paths.memories, logger);
  const longTermMemory = new LongTermMemoryStore(paths.longTermMemory);
  const consolidationState = new MemoryConsolidationStateStore(
    paths.memoryConsolidationState,
    logger,
  );
  const scheduledScheduler = new ScheduledMessageScheduler(
    schedules,
    createScheduledMessageDelivery(gateway),
    (text) => transport.logStatus(text),
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
  tools.register(
    createScheduledMessageTool({
      gateway,
      users,
      channels,
      store: schedules,
      status: transport,
      getActiveChannelId: () => session.getActiveChannelId(),
      getCreator: () => session.getActiveCreator(),
      logger,
    }),
  );
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
  const memoryConsolidator = new MemoryConsolidator(
    dependencies.consolidationModel,
    dependencies.consolidationInstructions,
    { summaries, shortTermMemories: memories, longTermMemory },
  );
  const memoryConsolidationScheduler = new MemoryConsolidationScheduler(
    memoryConsolidator,
    consolidationState,
    session,
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
        void scheduledScheduler.start();
        void memoryConsolidationScheduler.start();
        void registerUsageCommand(gateway, logger).catch((error: unknown) => {
          logger.warn("discord.command_registration_failed", { error: String(error) });
        });
      },
      handleCommand: (name, reply) => {
        if (name === "usage") void handleUsageCommand({ reply }, dependencies.usageStore, logger);
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
      scheduledScheduler.stop();
      memoryConsolidationScheduler.stop();
      await adapter.stop();
    },
  };
}
