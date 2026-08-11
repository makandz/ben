import type { Logger } from "../logger.js";
import { ModelBudgetExceededError } from "../model/Model.js";
import { buildUserPrompt, type KnownPeople } from "../prompts/formatMessages.js";
import { formatUsd } from "../util/formatCurrency.js";
import type { ChatTransport } from "./ChatTransport.js";
import type { PresenceTransport } from "./PresenceTransport.js";
import type { ConversationItem, ConversationOutcome, HumanMessage } from "./types.js";

const MESSAGE_DEBOUNCE_MS = 5_000;
const TYPING_DEBOUNCE_MS = 10_000;
const IDLE_SLEEP_MS = 5 * 60 * 1_000;
const TYPING_REFRESH_MS = 8_000;
const SLEEPING_CONTEXT_LIMIT = 5;

type SessionMode = "sleeping" | "awake" | "processing";

/** Optional session timing values used to replace local production defaults in tests. */
export type BotSessionTimingOverrides = {
  /** Quiet time after the latest message before processing begins. */
  messageDebounceMs?: number;
  /** Quiet time after human typing activity before processing begins. */
  typingDebounceMs?: number;
  /** Awake inactivity period before the session returns to sleep. */
  idleSleepMs?: number;
  /** Interval between typing-indicator refreshes during model work. */
  typingRefreshMs?: number;
};

type SessionTimings = Required<BotSessionTimingOverrides>;

/** Narrow conversation-running contract consumed by the session state machine. */
export type ConversationRunner = {
  /**
   * Runs one provider-neutral conversation turn.
   *
   * @param instructions - Stable model instructions.
   * @param history - Portable history retained while the session is awake.
   * @param userText - Model-ready user prompt for the current message batch.
   * @returns The terminal conversation outcome for the session to apply.
   */
  run(
    instructions: string,
    history: readonly ConversationItem[],
    userText: string,
  ): Promise<ConversationOutcome>;
};

export type ActiveConversationUser = {
  userId: string;
  username: string;
};

/** Persistence capabilities used at wake, prompt-build, and sleep boundaries. */
export type BotSessionPersistence = {
  summaries?: {
    /** @returns Saved conversation summaries in prompt order. */
    list(): Promise<readonly { summary: string }[]>;
    /**
     * Persists a completed conversation summary.
     *
     * @param summary - Required model-authored summary produced before sleep.
     * @returns A promise that resolves after persistence completes.
     */
    add(summary: string): Promise<unknown>;
  };
  knownPeople?: {
    /** @returns Known Discord users keyed by normalized username for prompt formatting. */
    listForPrompt(): Promise<KnownPeople>;
  };
};

export type BotSessionPromptContext = {
  /** @returns The current custom activity shown on Discord, when available. */
  getCurrentActivityStatus?(): string | undefined;
  /** @returns A formatted current bot-local time for scheduling context. */
  getCurrentBotTime?(): string | undefined;
};

type TypingActivity = { expiresAt: number };

type QueuedWake = {
  channelId: string;
  messages: HumanMessage[];
  recentContext: HumanMessage[];
};

const productionTimings: SessionTimings = {
  messageDebounceMs: MESSAGE_DEBOUNCE_MS,
  typingDebounceMs: TYPING_DEBOUNCE_MS,
  idleSleepMs: IDLE_SLEEP_MS,
  typingRefreshMs: TYPING_REFRESH_MS,
};

/** Owns Ben's single active Discord conversation and its wake/sleep lifecycle. */
export class BotSession {
  private readonly timings: SessionTimings;
  private mode: SessionMode = "sleeping";
  private activeChannelId: string | undefined;
  private sleepingContext = new Map<string, HumanMessage[]>();
  private pendingBatch: HumanMessage[] = [];
  private queuedDuringProcessing: HumanMessage[] = [];
  private queuedWakes: QueuedWake[] = [];
  private history: ConversationItem[] = [];
  private pendingRecentContext: HumanMessage[] = [];
  private lastMessageAt = new Map<string, number>();
  private typingByChannel = new Map<string, Map<string, TypingActivity>>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private typingTimer: NodeJS.Timeout | undefined;
  private botMessageSequence = 0;
  private activeCreator: ActiveConversationUser | undefined;

  /**
   * Creates the application session state machine.
   *
   * @param instructions - Stable model instructions for conversation turns.
   * @param orchestrator - Provider-neutral conversation runner.
   * @param transport - Provider-neutral chat output capability.
   * @param presence - Availability output capability.
   * @param logger - Structured application logger.
   * @param timingOverrides - Narrow timer overrides intended for behavior tests.
   * @param persistence - Optional summary and known-people persistence capabilities.
   * @throws When a timing override is negative or not finite.
   */
  constructor(
    private readonly instructions: string,
    private readonly orchestrator: ConversationRunner,
    private readonly transport: ChatTransport,
    private readonly presence: PresenceTransport,
    private readonly logger: Pick<Logger, "debug" | "info" | "warn">,
    timingOverrides: BotSessionTimingOverrides = {},
    private readonly persistence: BotSessionPersistence = {},
    private readonly promptContext: BotSessionPromptContext = {},
  ) {
    this.timings = { ...productionTimings, ...timingOverrides };

    for (const [name, value] of Object.entries(this.timings)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative finite number`);
      }
    }
  }

  /**
   * Receives one normalized human message and its direct-ping state.
   *
   * @param message - Provider-neutral human message.
   * @param pinged - Whether the message directly mentioned Ben.
   */
  handleMessage(message: HumanMessage, pinged: boolean): void {
    this.lastMessageAt.set(message.channelId, Date.now());
    this.clearTyping(message.channelId, message.userId);
    const recentContext = this.getSleepingContext(message.channelId);
    this.rememberMessage(message);

    if (this.mode === "sleeping") {
      if (pinged) this.wake([message], recentContext);
      return;
    }

    if (message.channelId !== this.activeChannelId) {
      const queued = this.queuedWakes.find((wake) => wake.channelId === message.channelId);

      if (queued !== undefined) {
        queued.messages.push(message);
      } else if (pinged) {
        this.queuedWakes.push({ channelId: message.channelId, messages: [message], recentContext });
      }

      return;
    }

    if (this.mode === "processing") {
      this.queuedDuringProcessing.push(message);
      return;
    }

    this.pendingBatch.push(message);
    this.scheduleDebounce();
    this.resetIdleTimer();
  }

  /**
   * Receives human typing activity that can postpone the active batch.
   *
   * @param channelId - Channel containing the typing activity.
   * @param userId - Typing user's identifier.
   * @param username - Typing user's display name for diagnostics.
   */
  handleTyping(channelId: string, userId: string, username: string): void {
    if (this.mode === "sleeping") return;

    const users = this.typingByChannel.get(channelId) ?? new Map<string, TypingActivity>();
    users.set(userId, { expiresAt: Date.now() + this.timings.typingDebounceMs });
    this.typingByChannel.set(channelId, users);
    this.logger.debug("typing.tracked", { channelId, username, activeUsers: users.size });

    if (this.mode === "awake" && this.pendingBatch[0]?.channelId === channelId) {
      this.scheduleDebounce();
      this.resetIdleTimer();
    }
  }

  /** Releases timers when application composition shuts down. */
  stop(): void {
    this.clearTimers();
  }

  /** @returns The active Discord channel, or undefined while sleeping. */
  getActiveChannelId(): string | undefined {
    return this.activeChannelId;
  }

  /** @returns The first human in the batch currently invoking tools, if any. */
  getActiveCreator(): ActiveConversationUser | undefined {
    return this.activeCreator === undefined ? undefined : { ...this.activeCreator };
  }

  /**
   * Adds successful bot output to a channel's bounded recent context.
   *
   * @param channelId - Channel that received the bot message.
   * @param content - Delivered message content.
   */
  recordBotMessage(channelId: string, content: string): void {
    this.botMessageSequence += 1;
    const message: HumanMessage = {
      id: `ben:${String(Date.now())}:${String(this.botMessageSequence)}`,
      channelId,
      userId: "ben",
      username: "Ben",
      content,
      createdAt: Date.now(),
    };
    this.rememberMessage(message);
    const queued = this.queuedWakes.find((wake) => wake.channelId === channelId);
    if (queued !== undefined) queued.messages.push(message);
  }

  /** Starts a conversation from a ping or promoted queued wake. */
  private wake(messages: HumanMessage[], recentContext: HumanMessage[]): void {
    const first = messages[0];
    if (first === undefined) return;

    this.mode = "awake";
    this.activeChannelId = first.channelId;
    this.pendingBatch = messages;
    this.pendingRecentContext = recentContext;
    this.queuedDuringProcessing = [];
    this.history = [];
    this.presence.setPresence({ status: "online" });
    this.logger.info("session.wake", { channelId: first.channelId, messages: messages.length });
    void this.logStatus("Woke up from a ping", { channelId: first.channelId });
    this.scheduleDebounce();
    this.resetIdleTimer();
  }

  /** Schedules processing after both message and typing activity settle. */
  private scheduleDebounce(): void {
    const channelId = this.pendingBatch[0]?.channelId;
    if (channelId === undefined) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);

    const now = Date.now();
    const delay = Math.max(0, this.getDebounceDueAt(channelId, now) - now);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.processIfSettled();
    }, delay);
  }

  /** Processes a due batch or reschedules it for remaining typing activity. */
  private processIfSettled(): void {
    const channelId = this.pendingBatch[0]?.channelId;
    if (channelId === undefined) return;

    const now = Date.now();
    const dueAt = this.getDebounceDueAt(channelId, now);

    if (dueAt > now) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        this.processIfSettled();
      }, dueAt - now);
      return;
    }

    void this.processPendingBatch();
  }

  /** Finds when a channel is quiet enough to process. */
  private getDebounceDueAt(channelId: string, now: number): number {
    const messageDueAt =
      (this.lastMessageAt.get(channelId) ?? now) + this.timings.messageDebounceMs;
    const typingDueAt = this.getActiveTyping(channelId, now).reduce(
      (latest, activity) => Math.max(latest, activity.expiresAt),
      0,
    );
    return Math.max(messageDueAt, typingDueAt);
  }

  /** Removes expired typing entries and returns those still active. */
  private getActiveTyping(channelId: string, now: number): TypingActivity[] {
    const users = this.typingByChannel.get(channelId);
    if (users === undefined) return [];

    for (const [userId, activity] of users) {
      if (activity.expiresAt <= now) users.delete(userId);
    }

    if (users.size === 0) this.typingByChannel.delete(channelId);
    return [...users.values()];
  }

  /** Runs one model turn and applies its terminal outcome. */
  private async processPendingBatch(): Promise<void> {
    if (this.mode !== "awake" || this.pendingBatch.length === 0) return;

    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const messages = this.pendingBatch;
    const recentContext = this.pendingRecentContext;
    const channelId = messages[0]?.channelId;
    const reactionMessageId = messages.at(-1)?.id;
    this.pendingBatch = [];
    this.pendingRecentContext = [];
    this.mode = "processing";
    const creator = messages[0];
    this.activeCreator =
      creator === undefined ? undefined : { userId: creator.userId, username: creator.username };

    const stopTyping = this.startTyping(channelId);
    const includeFirstPromptContext = this.history.length === 0;
    const knownPeople =
      (await this.persistence.knownPeople?.listForPrompt().catch((error: unknown) => {
        this.logger.warn("known_people.read_failed", { error: String(error) });
        return {};
      })) ?? {};
    const recentConversationSummaries = includeFirstPromptContext
      ? ((await this.persistence.summaries?.list().catch((error: unknown) => {
          this.logger.warn("conversation_summaries.read_failed", { error: String(error) });
          return [];
        })) ?? [])
      : [];
    const currentActivityStatus = this.promptContext.getCurrentActivityStatus?.();
    const currentBotTime = this.promptContext.getCurrentBotTime?.();
    const prompt = buildUserPrompt({
      recentContext,
      messages,
      knownPeople,
      includeKnownPeople: includeFirstPromptContext,
      recentConversationSummaries,
      ...(currentActivityStatus === undefined ? {} : { currentActivityStatus }),
      ...(currentBotTime === undefined ? {} : { currentBotTime }),
      ...(includeFirstPromptContext && messages[0] !== undefined
        ? { pingedByUsername: messages[0].username }
        : {}),
    });
    try {
      const outcome = await this.orchestrator
        .run(this.instructions, this.history, prompt)
        .catch((error: unknown): ConversationOutcome => ({ type: "failed", error }));
      await this.applyOutcome(outcome, channelId, reactionMessageId);
    } finally {
      this.activeCreator = undefined;
      stopTyping();
    }
  }

  /** Refreshes the active channel's typing indicator during model work. */
  private startTyping(channelId: string | undefined): () => void {
    if (channelId === undefined) return () => undefined;
    const send = (): void => {
      void this.transport.sendTyping(channelId).catch((error: unknown) => {
        this.logger.warn("chat.typing_failed", { error: String(error) });
      });
    };
    send();
    this.typingTimer = setInterval(send, this.timings.typingRefreshMs);
    return () => {
      if (this.typingTimer !== undefined) clearInterval(this.typingTimer);
      this.typingTimer = undefined;
    };
  }

  /** Delivers one outcome and advances the session state. */
  private async applyOutcome(
    outcome: ConversationOutcome,
    channelId: string | undefined,
    messageId: string | undefined,
  ): Promise<void> {
    if (outcome.type === "sleep") {
      await this.persistence.summaries?.add(outcome.summary).catch((error: unknown) => {
        this.logger.warn("conversation_summaries.write_failed", { error: String(error) });
      });
      await this.deliverOptionalReaction(channelId, messageId, outcome.reaction);
      await this.deliverOptionalMessage(channelId, outcome.text);
      await this.logStatus("Going back to sleep", { channelId, summary: outcome.summary });
      this.goToSleep("model");
      return;
    }

    if (outcome.type === "reply") {
      await this.deliverOptionalReaction(channelId, messageId, outcome.reaction);
      if (outcome.reasoningSummary !== undefined) {
        await this.logStatus("Model reasoning", { summary: outcome.reasoningSummary });
      }
      await this.deliverOptionalMessage(channelId, outcome.text);
      this.history = [...outcome.history];
    } else if (outcome.type === "react") {
      await this.deliverOptionalReaction(channelId, messageId, outcome.reaction);
      if (outcome.reasoningSummary !== undefined) {
        await this.logStatus("Model reasoning", { summary: outcome.reasoningSummary });
      }
      this.history = [...outcome.history];
    } else if (outcome.type === "wait") {
      await this.logStatus("Waiting for the next message", { channelId });
      this.history = [...outcome.history];
    } else {
      if (outcome.error instanceof ModelBudgetExceededError) {
        this.logger.info("model.budget_exceeded_ignored", {
          day: outcome.error.day,
          costUsd: outcome.error.costUsd,
          budgetUsd: outcome.error.budgetUsd,
        });
        await this.deliverOptionalMessage(
          channelId,
          `Daily OpenAI budget reached (${formatUsd(outcome.error.costUsd)} / ${formatUsd(outcome.error.budgetUsd)}). I will respond again after the next daily reset.`,
        );
      } else {
        this.logger.warn("conversation.failed", { error: String(outcome.error) });
      }
    }

    this.mode = "awake";

    if (this.queuedDuringProcessing.length > 0) {
      this.pendingBatch = this.queuedDuringProcessing;
      this.queuedDuringProcessing = [];
      this.scheduleDebounce();
    }

    this.resetIdleTimer();
  }

  /** Sends an optional message while containing transport failures. */
  private async deliverOptionalMessage(
    channelId: string | undefined,
    text: string | undefined,
  ): Promise<void> {
    if (text === undefined) return;
    if (channelId === undefined) {
      this.logger.warn("chat.send_failed", { error: "Missing channel ID" });
      return;
    }
    await this.transport.sendMessage(channelId, text).catch((error: unknown) => {
      this.logger.warn("chat.send_failed", { error: String(error) });
    });
  }

  /** Adds an optional reaction while containing transport failures. */
  private async deliverOptionalReaction(
    channelId: string | undefined,
    messageId: string | undefined,
    emoji: string | undefined,
  ): Promise<void> {
    if (emoji === undefined) return;
    if (channelId === undefined || messageId === undefined) {
      this.logger.warn("chat.reaction_failed", { error: "Missing reaction target" });
      return;
    }
    await this.transport.addReaction(channelId, messageId, emoji).catch((error: unknown) => {
      this.logger.warn("chat.reaction_failed", { error: String(error) });
    });
  }

  /** Resets the automatic sleep timer while the session is awake. */
  private resetIdleTimer(): void {
    if (this.mode === "sleeping" || this.mode === "processing") return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.goToSleep("idle"), this.timings.idleSleepMs);
  }

  /** Clears conversation memory, then promotes the oldest queued channel. */
  private goToSleep(reason: "model" | "idle"): void {
    this.clearTimers();
    this.mode = "sleeping";
    this.activeChannelId = undefined;
    this.pendingBatch = [];
    this.pendingRecentContext = [];
    this.queuedDuringProcessing = [];
    this.history = [];
    this.activeCreator = undefined;
    this.typingByChannel.clear();
    this.presence.setPresence({ status: "idle" });
    this.logger.info("session.sleep", { reason, queuedChannels: this.queuedWakes.length });

    const next = this.queuedWakes.shift();
    if (next !== undefined) this.wake(next.messages, next.recentContext);
  }

  /** Stores bounded recent context independently for each channel. */
  private rememberMessage(message: HumanMessage): void {
    const messages = this.sleepingContext.get(message.channelId) ?? [];
    messages.push(message);
    if (messages.length > SLEEPING_CONTEXT_LIMIT) messages.shift();
    this.sleepingContext.set(message.channelId, messages);
  }

  /** Returns an immutable snapshot of one channel's sleeping context. */
  private getSleepingContext(channelId: string): HumanMessage[] {
    return [...(this.sleepingContext.get(channelId) ?? [])];
  }

  /** Removes typing state when that user's message arrives. */
  private clearTyping(channelId: string, userId: string): void {
    const users = this.typingByChannel.get(channelId);
    if (users === undefined) return;
    users.delete(userId);
    if (users.size === 0) this.typingByChannel.delete(channelId);
  }

  /** Contains operational status failures. */
  private async logStatus(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.transport.logStatus(message, details).catch((error: unknown) => {
      this.logger.warn("chat.status_failed", { error: String(error) });
    });
  }

  /** Cancels all timers owned by the session. */
  private clearTimers(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (this.typingTimer !== undefined) clearInterval(this.typingTimer);
    this.debounceTimer = undefined;
    this.idleTimer = undefined;
    this.typingTimer = undefined;
  }
}
