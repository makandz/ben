import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { OpenAIResponder } from "../openai/responder.js";
import type { ApiMemory, ResponderResult } from "../openai/types.js";
import { buildUserPrompt } from "./formatMessages.js";
import type { BotMode, HumanMessage } from "./types.js";

type SendMessageToChannel = (channelId: string, text: string) => Promise<void>;
type SendTypingToChannel = (channelId: string) => Promise<void>;

export class BotSession {
  private mode: BotMode = "sleeping";
  private sleepFifo: HumanMessage[] = [];
  private pendingBatch: HumanMessage[] = [];
  private queuedWhileProcessing: HumanMessage[] = [];
  private apiMemory: ApiMemory = [];
  private recentContextForPendingBatch: HumanMessage[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private idleSleepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly responder: OpenAIResponder,
    private readonly sendMessage: SendMessageToChannel,
    private readonly sendTyping: SendTypingToChannel,
    private readonly logger: Logger,
  ) {}

  handleMessage(message: HumanMessage, ping: boolean): void {
    if (this.mode === "sleeping") {
      const recentContext = [...this.sleepFifo];
      this.addToSleepFifo(message);

      if (!ping) {
        this.logger.debug("fifo.message", {
          username: message.username,
          fifoCount: this.sleepFifo.length,
        });
        return;
      }

      this.wake(message, recentContext);
      return;
    }

    this.addToSleepFifo(message);

    if (this.mode === "processing") {
      this.queuedWhileProcessing.push(message);
      this.logger.debug("queue.message", {
        username: message.username,
        mode: this.mode,
        queued: this.queuedWhileProcessing.length,
      });
      return;
    }

    this.pendingBatch.push(message);
    this.logger.debug("queue.message", {
      username: message.username,
      mode: this.mode,
      pending: this.pendingBatch.length,
    });
    this.scheduleDebounce();
    this.resetIdleSleepTimer();
  }

  handleTyping(username: string): void {
    if (this.mode === "sleeping") {
      return;
    }

    if (this.mode === "processing") {
      this.logger.debug("typing.processing", { username });
      return;
    }

    this.logger.debug("typing.debounce_reset", { username });
    this.scheduleDebounce();
    this.resetIdleSleepTimer();
  }

  private wake(message: HumanMessage, recentContext: HumanMessage[]): void {
    this.mode = "awake";
    this.pendingBatch = [message];
    this.recentContextForPendingBatch = recentContext;
    this.apiMemory = [];
    this.queuedWhileProcessing = [];

    this.logger.info("mode.wake", {
      by: message.username,
      contextCount: recentContext.length,
    });

    this.scheduleDebounce();
    this.resetIdleSleepTimer();
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.processPendingBatch();
    }, this.config.debounceMs);

    this.logger.debug("debounce.scheduled", {
      delayMs: this.config.debounceMs,
      pending: this.pendingBatch.length,
    });
  }

  private resetIdleSleepTimer(): void {
    if (this.idleSleepTimer !== undefined) {
      clearTimeout(this.idleSleepTimer);
    }

    this.idleSleepTimer = setTimeout(() => {
      this.goToSleep("idle_timeout");
    }, this.config.idleSleepMs);
  }

  private async processPendingBatch(): Promise<void> {
    if (this.mode === "processing" || this.pendingBatch.length === 0) {
      return;
    }

    if (this.idleSleepTimer !== undefined) {
      clearTimeout(this.idleSleepTimer);
      this.idleSleepTimer = undefined;
    }

    const messages = this.pendingBatch;
    const recentContext = this.recentContextForPendingBatch;
    const userPrompt = buildUserPrompt({ recentContext, messages });
    const responseChannelId = messages[0]?.channelId;

    this.pendingBatch = [];
    this.recentContextForPendingBatch = [];
    this.mode = "processing";

    this.logger.info("mode.processing", {
      messages: messages.length,
      contextCount: recentContext.length,
      memoryItems: this.apiMemory.length,
    });

    const stopTyping = this.startTyping(responseChannelId);

    try {
      const result = await this.responder.respond(userPrompt, this.apiMemory);
      await this.handleResponderResult(result, responseChannelId);
    } finally {
      stopTyping();
    }
  }

  private startTyping(channelId: string | undefined): () => void {
    if (channelId === undefined) {
      return () => undefined;
    }

    const send = (): void => {
      void this.sendTyping(channelId).catch((error: unknown) => {
        this.logger.warn("discord.typing_failed", { error: String(error) });
      });
    };

    send();
    const typingTimer = setInterval(send, 8_000);

    return () => {
      clearInterval(typingTimer);
    };
  }

  private async handleResponderResult(
    result: ResponderResult,
    responseChannelId: string | undefined,
  ): Promise<void> {
    if (result.type === "sleep") {
      this.goToSleep("model_na");
      return;
    }

    if (result.type === "message") {
      try {
        if (responseChannelId === undefined) {
          throw new Error("Cannot send a response without a channel ID.");
        }

        const messageText = formatDiscordResponse(result);
        const messageParts = splitDiscordResponse(messageText);

        await this.sendMessageParts(responseChannelId, messageParts);
        this.apiMemory = [...this.apiMemory, ...result.memoryItems];
        this.logger.info("discord.sent", {
          chars: messageText.length,
          messages: messageParts.length,
          reasoningSummaryChars: result.reasoningSummary?.length ?? 0,
          memoryItems: this.apiMemory.length,
        });
      } catch (error) {
        this.logger.warn("discord.send_failed", { error: String(error) });
      }
    }

    if (result.type === "failed") {
      this.logger.info("openai.failed_ignored", {
        queued: this.queuedWhileProcessing.length,
      });
    }

    if (result.type === "budget_exceeded") {
      this.logger.info("openai.budget_exceeded_ignored", {
        day: result.day,
        costUsd: result.costUsd,
        budgetUsd: result.budgetUsd,
        queued: this.queuedWhileProcessing.length,
      });

      if (responseChannelId !== undefined) {
        await this.sendMessage(
          responseChannelId,
          `Daily OpenAI budget reached (${formatUsd(result.costUsd)} / ${formatUsd(result.budgetUsd)}). I will respond again after the next daily reset.`,
        ).catch((error: unknown) => {
          this.logger.warn("discord.send_failed", { error: String(error) });
        });
      }
    }

    this.mode = "awake";

    if (this.queuedWhileProcessing.length > 0) {
      this.pendingBatch = this.queuedWhileProcessing;
      this.queuedWhileProcessing = [];
      this.logger.info("queue.promoted", { pending: this.pendingBatch.length });
      this.scheduleDebounce();
      this.resetIdleSleepTimer();
      return;
    }

    this.resetIdleSleepTimer();
    this.logger.info("mode.awake_idle");
  }

  private async sendMessageParts(channelId: string, messageParts: string[]): Promise<void> {
    for (const [index, messagePart] of messageParts.entries()) {
      if (index > 0) {
        await delay(this.config.messageLineDelayMs);
      }

      await this.sendMessage(channelId, messagePart);
    }
  }

  private goToSleep(reason: string): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.idleSleepTimer !== undefined) {
      clearTimeout(this.idleSleepTimer);
      this.idleSleepTimer = undefined;
    }

    this.mode = "sleeping";
    this.pendingBatch = [];
    this.queuedWhileProcessing = [];
    this.apiMemory = [];
    this.recentContextForPendingBatch = [];

    this.logger.info("mode.sleep", {
      reason,
      fifoCount: this.sleepFifo.length,
    });
  }

  private addToSleepFifo(message: HumanMessage): void {
    this.sleepFifo.push(message);

    if (this.sleepFifo.length > 5) {
      this.sleepFifo.shift();
    }
  }
}

function formatDiscordResponse(result: Extract<ResponderResult, { type: "message" }>): string {
  if (result.reasoningSummary === undefined) {
    return result.text;
  }

  return `> 💭 ${stripBoldMarkdown(result.reasoningSummary)}\n\n${result.text}`;
}

function splitDiscordResponse(text: string): string[] {
  const parts = text
    .split(/\r?\n/)
    .filter((part) => part.trim().length > 0);

  return parts.length > 0 ? parts : [text];
}

function stripBoldMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1");
}

async function delay(ms: number): Promise<void> {
  if (ms === 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
