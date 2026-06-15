import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { OpenAIResponder } from "../openai/responder.js";
import type {
  ApiMemory,
  RememberPersonToolInput,
  RememberPersonToolResult,
  ResponderResult,
  SendChannelMessageToolInput,
  SendChannelMessageToolResult,
} from "../openai/types.js";
import type { ConversationSummaryStore } from "./conversationSummaryStore.js";
import { buildUserPrompt } from "./formatMessages.js";
import type { KnownPeopleStore } from "./knownPeopleStore.js";
import type { BotMode, HumanMessage } from "./types.js";

type SendMessageToChannel = (channelId: string, text: string) => Promise<void>;
type SendStatusMessage = (text: string, fallbackChannelId: string | undefined) => Promise<void>;
type SendTypingToChannel = (channelId: string) => Promise<void>;
type ReactToMessage = (channelId: string, messageId: string, emoji: string) => Promise<void>;
type GetCurrentActivityStatus = () => string | undefined;
type SetAwakePresence = (awake: boolean) => void;
type RememberPerson = (
  input: RememberPersonToolInput,
  channelId: string | undefined,
) => Promise<RememberPersonToolResult>;
type SendChannelMessage = (
  input: SendChannelMessageToolInput,
  activeChannelId: string | undefined,
) => Promise<SendChannelMessageToolResult>;

interface TypingActivity {
  expiresAt: number;
}

interface QueuedWakeRequest {
  channelId: string;
  messages: HumanMessage[];
  recentContext: HumanMessage[];
}

export class BotSession {
  private mode: BotMode = "sleeping";
  private activeChannelId: string | undefined;
  private sleepFifoByChannel = new Map<string, HumanMessage[]>();
  private pendingBatch: HumanMessage[] = [];
  private queuedWhileProcessing: HumanMessage[] = [];
  private queuedWakeRequests: QueuedWakeRequest[] = [];
  private apiMemory: ApiMemory = [];
  private recentContextForPendingBatch: HumanMessage[] = [];
  private channelLastMessageAt = new Map<string, number>();
  private channelTypingByUser = new Map<string, Map<string, TypingActivity>>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private idleSleepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly responder: OpenAIResponder,
    private readonly sendMessage: SendMessageToChannel,
    private readonly sendStatus: SendStatusMessage,
    private readonly sendTyping: SendTypingToChannel,
    private readonly reactToMessage: ReactToMessage,
    private readonly getCurrentActivityStatus: GetCurrentActivityStatus,
    private readonly setAwakePresence: SetAwakePresence,
    private readonly conversationSummaryStore: ConversationSummaryStore,
    private readonly knownPeopleStore: KnownPeopleStore,
    private readonly rememberPerson: RememberPerson,
    private readonly sendChannelMessage: SendChannelMessage,
    private readonly logger: Logger,
  ) {}

  handleMessage(message: HumanMessage, ping: boolean): void {
    this.markMessageActivity(message);
    const recentContext = this.getSleepFifo(message.channelId);

    if (this.mode === "sleeping") {
      this.addToSleepFifo(message);

      if (!ping) {
        this.logger.debug("fifo.message", {
          channelId: message.channelId,
          username: message.username,
          fifoCount: this.getSleepFifo(message.channelId).length,
        });
        return;
      }

      this.wake([message], recentContext);
      return;
    }

    this.addToSleepFifo(message);

    if (message.channelId !== this.activeChannelId) {
      const queuedWakeRequest = this.queuedWakeRequests.find(
        (request) => request.channelId === message.channelId,
      );

      if (queuedWakeRequest !== undefined) {
        queuedWakeRequest.messages.push(message);
        this.logger.info("wake_queue.message_added", {
          channelId: message.channelId,
          username: message.username,
          messages: queuedWakeRequest.messages.length,
        });
        return;
      }

      if (ping) {
        this.queuedWakeRequests.push({
          channelId: message.channelId,
          messages: [message],
          recentContext,
        });
        this.logger.info("wake_queue.queued", {
          channelId: message.channelId,
          username: message.username,
          queuedChannels: this.queuedWakeRequests.length,
        });
      } else {
        this.logger.debug("fifo.other_channel_message", {
          activeChannelId: this.activeChannelId,
          channelId: message.channelId,
          username: message.username,
        });
      }

      return;
    }

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

  handleTyping(channelId: string, userId: string, username: string): void {
    if (this.mode === "sleeping") {
      return;
    }

    this.markTypingActivity(channelId, userId, username);

    if (this.mode === "processing") {
      this.logger.debug("typing.processing", { channelId, username });
      return;
    }

    const pendingChannelId = this.pendingBatch[0]?.channelId;

    if (pendingChannelId === undefined) {
      this.logger.debug("typing.tracked_idle", { channelId, username });
      return;
    }

    if (channelId !== pendingChannelId) {
      this.logger.debug("typing.ignored_other_channel", { channelId, username });
      return;
    }

    this.logger.debug("typing.debounce_reset", { username });
    this.scheduleDebounce();
    this.resetIdleSleepTimer();
  }

  private wake(messages: HumanMessage[], recentContext: HumanMessage[]): void {
    const firstMessage = messages[0];

    if (firstMessage === undefined) {
      return;
    }

    this.mode = "awake";
    this.activeChannelId = firstMessage.channelId;
    this.setAwakePresence(true);
    this.pendingBatch = messages;
    this.recentContextForPendingBatch = recentContext;
    this.apiMemory = [];
    this.queuedWhileProcessing = [];

    this.logger.info("mode.wake", {
      channelId: firstMessage.channelId,
      by: firstMessage.username,
      messages: messages.length,
      contextCount: recentContext.length,
    });

    void this.sendStatusMessage("Woke up from a ping", firstMessage.channelId);
    this.scheduleDebounce();
    this.resetIdleSleepTimer();
  }

  private scheduleDebounce(): void {
    const channelId = this.pendingBatch[0]?.channelId;

    if (channelId === undefined) {
      return;
    }

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }

    const now = Date.now();
    const dueAt = this.getDebounceDueAt(channelId, now);
    const delayMs = Math.max(0, dueAt - now);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.processPendingBatchIfIdle();
    }, delayMs);

    this.logger.debug("debounce.scheduled", {
      channelId,
      delayMs,
      pending: this.pendingBatch.length,
      activeTypingUsers: this.getActiveTypingCount(channelId, now),
    });
  }

  private getDebounceDueAt(channelId: string, now: number): number {
    const lastMessageAt = this.channelLastMessageAt.get(channelId) ?? now;
    const activeTyping = this.getActiveTyping(channelId, now);

    return Math.max(
      lastMessageAt + this.config.messageDebounceMs,
      ...activeTyping.map((activity) => activity.expiresAt),
    );
  }

  private getActiveTypingCount(channelId: string, now: number): number {
    return this.getActiveTyping(channelId, now).length;
  }

  private getActiveTyping(channelId: string, now: number): TypingActivity[] {
    const typingByUser = this.channelTypingByUser.get(channelId);

    if (typingByUser === undefined) {
      return [];
    }

    const activeTyping: TypingActivity[] = [];

    for (const [userId, activity] of typingByUser.entries()) {
      if (activity.expiresAt <= now) {
        typingByUser.delete(userId);
        continue;
      }

      activeTyping.push(activity);
    }

    if (typingByUser.size === 0) {
      this.channelTypingByUser.delete(channelId);
    }

    return activeTyping;
  }

  private markTypingActivity(channelId: string, userId: string, username: string): void {
    const typingByUser = this.channelTypingByUser.get(channelId) ?? new Map<string, TypingActivity>();
    const expiresAt = Date.now() + this.config.typingDebounceMs;

    typingByUser.set(userId, { expiresAt });
    this.channelTypingByUser.set(channelId, typingByUser);

    this.logger.debug("typing.tracked", {
      channelId,
      username,
      activeTypingUsers: typingByUser.size,
      expiresInMs: this.config.typingDebounceMs,
    });
  }

  private markMessageActivity(message: HumanMessage): void {
    this.channelLastMessageAt.set(message.channelId, Date.now());
    this.clearTypingActivity(message.channelId, message.userId);
  }

  private clearTypingActivity(channelId: string, userId: string): void {
    const typingByUser = this.channelTypingByUser.get(channelId);

    if (typingByUser === undefined) {
      return;
    }

    typingByUser.delete(userId);

    if (typingByUser.size === 0) {
      this.channelTypingByUser.delete(channelId);
    }
  }

  private processPendingBatchIfIdle(): void {
    const channelId = this.pendingBatch[0]?.channelId;

    if (channelId === undefined) {
      void this.processPendingBatch();
      return;
    }

    const now = Date.now();
    const dueAt = this.getDebounceDueAt(channelId, now);

    if (dueAt > now) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        this.processPendingBatchIfIdle();
      }, dueAt - now);

      this.logger.debug("debounce.waiting_for_idle", {
        channelId,
        remainingMs: dueAt - now,
        messageDebounceMs: this.config.messageDebounceMs,
        activeTypingUsers: this.getActiveTypingCount(channelId, now),
        pending: this.pendingBatch.length,
      });
      return;
    }

    void this.processPendingBatch();
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
    const includeFirstPromptContext = this.apiMemory.length === 0;
    const currentActivityStatus = includeFirstPromptContext
      ? this.getCurrentActivityStatus()
      : undefined;
    const recentConversationSummaries = includeFirstPromptContext
      ? await this.conversationSummaryStore.list()
      : [];
    const knownPeople = await this.knownPeopleStore.listForPrompt().catch((error: unknown) => {
      this.logger.warn("known_people.read_failed", { error: String(error) });
      return {};
    });
    const promptOptions: Parameters<typeof buildUserPrompt>[0] = {
      recentContext,
      messages,
      knownPeople,
      includeKnownPeople: includeFirstPromptContext,
      recentConversationSummaries,
    };

    if (currentActivityStatus !== undefined) {
      promptOptions.currentActivityStatus = currentActivityStatus;
    }

    if (includeFirstPromptContext && messages[0] !== undefined) {
      promptOptions.pingedByUsername = messages[0].username;
    }

    const userPrompt = buildUserPrompt(promptOptions);
    const responseChannelId = messages[0]?.channelId;
    const reactionTargetMessageId = messages.at(-1)?.id;

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
      const result = await this.responder.respond(userPrompt, this.apiMemory, {
        rememberPerson: (input) => this.rememberPerson(input, responseChannelId),
        sendChannelMessage: async (input) => {
          const result = await this.sendChannelMessage(input, responseChannelId);

          if (result.ok) {
            this.addBotMessageToSleepFifo(result.channelId, input.text);
          }

          return result;
        },
      });
      await this.handleResponderResult(result, responseChannelId, reactionTargetMessageId);
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
    reactionTargetMessageId: string | undefined,
  ): Promise<void> {
    if (result.type === "sleep") {
      if (result.reactionEmoji !== undefined) {
        await this.reactToLatestMessage(responseChannelId, reactionTargetMessageId, result.reactionEmoji)
          .then(() => {
            this.logger.info("discord.reacted", { emoji: result.reactionEmoji });
          })
          .catch((error: unknown) => {
            this.logger.warn("discord.react_failed", { error: String(error) });
          });
      }

      if (result.text !== undefined) {
        if (responseChannelId === undefined) {
          this.logger.warn("discord.send_failed", {
            error: "Cannot send a response without a channel ID.",
          });
        } else {
          await this.sendMessage(responseChannelId, result.text)
            .then(() => {
              this.logger.info("discord.sent", { chars: result.text?.length ?? 0 });
            })
            .catch((error: unknown) => {
              this.logger.warn("discord.send_failed", { error: String(error) });
            });
        }
      }

      await this.conversationSummaryStore.add(result.summary).catch((error: unknown) => {
        this.logger.warn("conversation_summaries.write_failed", { error: String(error) });
      });
      await this.sendStatusMessage("Going back to sleep", responseChannelId);
      this.goToSleep("model_na");
      return;
    }

    if (result.type === "message") {
      try {
        if (responseChannelId === undefined) {
          throw new Error("Cannot send a response without a channel ID.");
        }

        if (result.reactionEmoji !== undefined) {
          await this.reactToLatestMessage(
            responseChannelId,
            reactionTargetMessageId,
            result.reactionEmoji,
          )
            .then(() => {
              this.logger.info("discord.reacted", { emoji: result.reactionEmoji });
            })
            .catch((error: unknown) => {
              this.logger.warn("discord.react_failed", { error: String(error) });
            });
        }

        if (result.reasoningSummary !== undefined) {
          await this.sendStatusMessage(
            formatReasoningStatus(result.reasoningSummary),
            responseChannelId,
          );
        }

        const messageText = result.text;

        await this.sendMessage(responseChannelId, messageText);
        this.apiMemory = [...this.apiMemory, ...result.memoryItems];
        this.logger.info("discord.sent", {
          chars: messageText.length,
          reasoningSummaryChars: result.reasoningSummary?.length ?? 0,
          memoryItems: this.apiMemory.length,
        });
      } catch (error) {
        this.logger.warn("discord.send_failed", { error: String(error) });
      }
    }

    if (result.type === "reaction") {
      try {
        await this.reactToLatestMessage(responseChannelId, reactionTargetMessageId, result.emoji);
        this.apiMemory = [...this.apiMemory, ...result.memoryItems];
        this.logger.info("discord.reacted", {
          emoji: result.emoji,
          memoryItems: this.apiMemory.length,
        });
      } catch (error) {
        this.logger.warn("discord.react_failed", { error: String(error) });
      }
    }

    if (result.type === "wait") {
      await this.sendStatusMessage("Waiting for the next message..", responseChannelId);
      this.apiMemory = [...this.apiMemory, ...result.memoryItems];
      this.logger.info("mode.wait", {
        queued: this.queuedWhileProcessing.length,
        memoryItems: this.apiMemory.length,
      });
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

  private async sendStatusMessage(
    text: string,
    fallbackChannelId: string | undefined,
  ): Promise<void> {
    await this.sendStatus(text, fallbackChannelId).catch((error: unknown) => {
      this.logger.warn("discord.status_send_failed", { error: String(error) });
    });
  }

  private async reactToLatestMessage(
    channelId: string | undefined,
    messageId: string | undefined,
    emoji: string,
  ): Promise<void> {
    if (channelId === undefined || messageId === undefined) {
      throw new Error("Cannot react without a channel ID and target message ID.");
    }

    await this.reactToMessage(channelId, messageId, emoji);
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
    this.activeChannelId = undefined;
    this.setAwakePresence(false);
    this.pendingBatch = [];
    this.queuedWhileProcessing = [];
    this.apiMemory = [];
    this.recentContextForPendingBatch = [];
    this.channelTypingByUser.clear();

    this.logger.info("mode.sleep", {
      reason,
      queuedWakeRequests: this.queuedWakeRequests.length,
    });

    this.wakeNextQueuedChannel();
  }

  private addToSleepFifo(message: HumanMessage): void {
    const fifo = this.sleepFifoByChannel.get(message.channelId) ?? [];
    fifo.push(message);

    if (fifo.length > 5) {
      fifo.shift();
    }

    this.sleepFifoByChannel.set(message.channelId, fifo);
  }

  private getSleepFifo(channelId: string): HumanMessage[] {
    return [...(this.sleepFifoByChannel.get(channelId) ?? [])];
  }

  private addBotMessageToSleepFifo(channelId: string, content: string): void {
    const message: HumanMessage = {
      id: `ben:${String(Date.now())}:${String(Math.random())}`,
      channelId,
      userId: "ben",
      username: "Ben",
      content,
      createdAt: Date.now(),
    };

    this.addToSleepFifo(message);

    const queuedWakeRequest = this.queuedWakeRequests.find(
      (request) => request.channelId === channelId,
    );

    if (queuedWakeRequest !== undefined) {
      queuedWakeRequest.messages.push(message);
    }
  }

  private wakeNextQueuedChannel(): void {
    const nextWakeRequest = this.queuedWakeRequests.shift();

    if (nextWakeRequest === undefined) {
      return;
    }

    this.logger.info("wake_queue.promoted", {
      channelId: nextWakeRequest.channelId,
      messages: nextWakeRequest.messages.length,
      remainingQueuedChannels: this.queuedWakeRequests.length,
    });

    this.wake(nextWakeRequest.messages, nextWakeRequest.recentContext);
  }
}

function formatReasoningStatus(reasoningSummary: string): string {
  return `> 💭 ${stripBoldMarkdown(reasoningSummary)}`;
}

function stripBoldMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1");
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
