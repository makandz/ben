import "dotenv/config";

import { pathToFileURL } from "node:url";

import { createApplication, type Application } from "./app/createApplication.js";
import { DiscordJsGateway } from "./discord/DiscordJsGateway.js";
import { loadEnv, type AppEnv, type LogLevel } from "./env.js";
import { Logger } from "./logger.js";
import { OpenAIModel, OPENAI_CONVERSATION_MODEL } from "./model/openai/OpenAIModel.js";
import { OpenAIUsageStore } from "./model/openai/OpenAIUsageStore.js";
import { loadMemoryConsolidationPrompt } from "./prompting/memoryConsolidationPrompt.js";
import { composeInstructions, loadBasePrompt } from "./prompting/promptLayers.js";
import { loadMessagingPrompt } from "./prompting/messagingPrompt.js";

export { loadEnv, type AppEnv, type LogLevel };
export { Logger, type LogData } from "./logger.js";
export {
  BotSession,
  type ActiveConversationUser,
  type BotSessionPersistence,
  type BotSessionTimingOverrides,
  type BotSessionPromptContext,
  type ConversationRunner,
} from "./app/BotSession.js";
export {
  createApplication,
  type Application,
  type ApplicationDependencies,
} from "./app/createApplication.js";

/**
 * Builds the production replacement while leaving login under the caller's control.
 *
 * @returns The fully wired replacement application.
 */
export async function createDefaultApplication(): Promise<Application> {
  const env = loadEnv();
  const logger = new Logger(env.logLevel);
  const gateway = new DiscordJsGateway();
  const usageStore = new OpenAIUsageStore(
    "logs/openai-usage",
    OPENAI_CONVERSATION_MODEL,
    env.openaiDailyBudgetUsd,
    logger,
  );
  const [baseInstructions, conversationInstructions, consolidationTaskInstructions] =
    await Promise.all([loadBasePrompt(), loadMessagingPrompt(), loadMemoryConsolidationPrompt()]);
  const instructions = composeInstructions(baseInstructions, conversationInstructions);
  const consolidationInstructions = composeInstructions(
    baseInstructions,
    consolidationTaskInstructions,
  );
  return createApplication({
    env,
    logger,
    gateway,
    usageStore,
    conversationModel: new OpenAIModel({ apiKey: env.openaiApiKey }, usageStore),
    consolidationModel: new OpenAIModel(
      { apiKey: env.openaiApiKey, maxOutputTokens: 2_048 },
      usageStore,
    ),
    instructions,
    consolidationInstructions,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await createDefaultApplication();
  const stop = (): void => {
    void application.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await application.start();
}
