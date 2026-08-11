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
import { handleUsageCommand, registerUsageCommand } from "../discord/UsageCommand.js";
import { createScheduledMessageTool } from "../discord/tools/createScheduledMessage.js";
import { createRememberPersonTool } from "../discord/tools/rememberPerson.js";
import { createSendMessageTool } from "../discord/tools/sendChannelMessage.js";
import { InternalActionRunner } from "../internal/InternalActionRunner.js";
import { InternalActionScheduler } from "../internal/InternalActionScheduler.js";
import { InternalStateStore } from "../internal/InternalStateStore.js";
import type { Model } from "../model/Model.js";
import { OpenAIUsageStore } from "../model/openai/OpenAIUsageStore.js";
import { formatBotTime } from "../scheduling/scheduleTime.js";
import {
  ScheduledMessageScheduler,
  SCHEDULE_TIME_ZONE,
} from "../scheduling/ScheduledMessageScheduler.js";
import { ConversationSummaryStore } from "../storage/ConversationSummaryStore.js";
import { KnownPeopleStore } from "../storage/KnownPeopleStore.js";
import { ScheduledMessageStore } from "../storage/ScheduledMessageStore.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { sleepTool, waitTool } from "../tools/conversationControls.js";

const paths = {
  internal: "logs/internal-state.json",
  summaries: "logs/conversation-summaries.json",
  people: "logs/known-people.json",
  schedules: "logs/scheduled-messages.json",
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
  internalModel: Model;
  instructions: string;
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
  const transport = new DiscordTransport(gateway, users, channels, env.discordLogChannelId, logger);
  const presence = new DiscordPresence(gateway);
  const summaries = new ConversationSummaryStore(paths.summaries, logger);
  const people = new KnownPeopleStore(paths.people, logger);
  const schedules = new ScheduledMessageStore(paths.schedules, logger);
  const internalScheduler = new InternalActionScheduler(
    new InternalActionRunner(dependencies.internalModel, logger, env.logPrompts),
    new InternalStateStore(paths.internal, logger),
    presence,
    transport,
    logger,
  );
  const scheduledScheduler = new ScheduledMessageScheduler(
    schedules,
    createScheduledMessageDelivery(gateway),
    (text) => transport.logStatus(text),
    logger,
  );

  let session: BotSession;
  const tools = new ToolRegistry([waitTool, sleepTool]);
  tools.register(
    createSendMessageTool({
      gateway,
      transport,
      channels,
      getActiveChannelId: () => session.getActiveChannelId(),
      recordBotMessage: (channelId, content) => session.recordBotMessage(channelId, content),
      logger,
    }),
  );
  tools.register(
    createRememberPersonTool({
      gateway,
      users,
      store: people,
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
    internalScheduler,
    logger,
    {},
    { summaries, knownPeople: people },
    {
      getCurrentActivityStatus: () => internalScheduler.getCurrentActivityStatus(),
      getCurrentBotTime: () => formatBotTime(new Date(), SCHEDULE_TIME_ZONE),
    },
  );

  let ready = false;
  const adapter = new DiscordAdapter(
    gateway,
    {
      handleMessage: (message, pinged) => session.handleMessage(message, pinged),
      handleTyping: (channelId, userId, username) =>
        session.handleTyping(channelId, userId, username),
      handleReady: () => {
        if (ready) return;
        ready = true;
        internalScheduler.setAwakePresence(false);
        void internalScheduler.start();
        void scheduledScheduler.start();
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
    start: () => adapter.start(env.discordToken),
    async stop() {
      session.stop();
      internalScheduler.stop();
      scheduledScheduler.stop();
      await adapter.stop();
    },
  };
}
