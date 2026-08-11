import "dotenv/config";

import { pathToFileURL } from "node:url";

import { createApplication, type Application } from "./app/createApplication.js";
import { DiscordJsGateway } from "./discord/DiscordJsGateway.js";
import { loadEnv, type AppEnv, type LogLevel } from "./env.js";
import { Logger } from "./logger.js";
import { OpenAIModel, OPENAI_CONVERSATION_MODEL, OPENAI_INTERNAL_MODEL } from "./model/openai/OpenAIModel.js";
import { OpenAIUsageStore } from "./model/openai/OpenAIUsageStore.js";
import { loadSystemPrompt } from "./prompts/systemPrompt.js";

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
export { createApplication, type Application, type ApplicationDependencies } from "./app/createApplication.js";

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
  return createApplication({
    env,
    logger,
    gateway,
    usageStore,
    conversationModel: new OpenAIModel({ apiKey: env.openaiApiKey }, usageStore),
    internalModel: new OpenAIModel({
      apiKey: env.openaiApiKey,
      model: OPENAI_INTERNAL_MODEL,
      maxOutputTokens: 96,
    }, usageStore),
    instructions: await loadSystemPrompt(),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await createDefaultApplication();
  const stop = (): void => { void application.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await application.start();
}
