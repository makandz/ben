import type { Logger } from "../logger.js";
import { ModelBudgetExceededError } from "../model/Model.js";
import { buildUserPrompt, type KnownPeople, type MemoryItem } from "../prompting/formatMessages.js";
import { formatUsd } from "../util/formatCurrency.js";
import type { ChatTransport } from "./ChatTransport.js";
import type { PresenceTransport } from "./PresenceTransport.js";
import type { ConversationItem, ConversationOutcome, HumanMessage } from "./types.js";
import type { AutonomousTask } from "../storage/TaskStore.js";

const MESSAGE_DEBOUNCE_MS = 5_000;
const TYPING_DEBOUNCE_MS = 10_000;
const IDLE_SLEEP_MS = 5 * 60 * 1_000;
const TYPING_REFRESH_MS = 8_000;
const SLEEPING_CONTEXT_LIMIT = 5;

type SessionMode = "sleeping" | "dreaming" | "awake" | "processing";

export type BotSessionTimingOverrides = {
  messageDebounceMs?: number;
  typingDebounceMs?: number;
  idleSleepMs?: number;
  typingRefreshMs?: number;
};

type SessionTimings = Required<BotSessionTimingOverrides>;

export type ConversationRunner = {
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

export type BotSessionPersistence = {
  summaries?: {
    list(): Promise<readonly { summary: string }[]>;
    add(summary: string): Promise<unknown>;
  };
  knownPeople?: {
    listForPrompt(): Promise<KnownPeople>;
  };
  customStatus?: {
    get(): Promise<string | undefined>;
  };
  memories?: {
    list(): Promise<readonly MemoryItem[]>;
  };
  longTermMemory?: {
    get(): Promise<string | undefined>;
  };
};

export type BotSessionPromptContext = {
  getCurrentBotTime?(): string | undefined;
};

type TypingActivity = { expiresAt: number };

type HumanWake = {
  kind: "human";
  channelId: string;
  messages: HumanMessage[];
  recentContext: HumanMessage[];
};

type TaskWake = {
  kind: "task";
  channelId: string;
  task: AutonomousTask;
  messages: HumanMessage[];
  recentContext: HumanMessage[];
  complete: () => Promise<void>;
};

type QueuedWake = HumanWake | TaskWake;

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
  private activeMessageIds = new Set<string>();
  private activeCreator: ActiveConversationUser | undefined;
  private activeTaskWake: TaskWake | undefined;
  private taskPromptPending = false;
  private taskStarting = false;

  /**
   * Creates the application session state machine.
   *
   * @param instructions - Stable model instructions for conversation turns.
   * @param orchestrator - Provider-neutral conversation runner.
   * @param transport - Provider-neutral chat output capability.
   * @param presence - Availability output capability.
   * @param logger - Structured application logger.
   * @param timingOverrides - Narrow timer overrides intended for behavior tests.
   * @param persistence - Optional durable context and session-state persistence capabilities.
   * @param promptContext - Optional dynamic local-time prompt values.
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
      if (pinged)
        this.activateWake({
          kind: "human",
          channelId: message.channelId,
          messages: [message],
          recentContext,
        });
      return;
    }

    if (message.channelId !== this.activeChannelId) {
      const queued = this.queuedWakes.find((wake) => wake.channelId === message.channelId);

      if (queued !== undefined) {
        queued.messages.push(message);
      } else if (pinged) {
        this.queuedWakes.push({
          kind: "human",
          channelId: message.channelId,
          messages: [message],
          recentContext,
        });
      }

      return;
    }

    this.activeMessageIds.add(message.id);

    if (this.mode === "processing") {
      this.queuedDuringProcessing.push(message);
      return;
    }

    this.pendingBatch.push(message);
    this.scheduleDebounce();
    this.resetIdleTimer();
  }

  /**
   * Queues a self-authored task wake without fabricating a human message.
   *
   * The task starts immediately only while Ben is sleeping; otherwise it waits FIFO behind the
   * active conversation and any earlier wakes.
   *
   * @param task - Persisted one-time task to run in its resolved destination channel.
   * @param complete - Durable completion callback invoked when the task conversation sleeps.
   */
  enqueueTask(task: AutonomousTask, complete: () => Promise<void>): void {
    const wake: TaskWake = {
      kind: "task",
      channelId: task.destination.channelId,
      task,
      messages: [],
      recentContext: this.getSleepingContext(task.destination.channelId),
      complete,
    };
    if (this.mode === "sleeping") this.activateWake(wake);
    else this.queuedWakes.push(wake);
  }

  /**
   * Receives human typing activity that can postpone the active batch.
   *
   * @param channelId - Channel containing the typing activity.
   * @param userId - Typing user's identifier.
   * @param username - Typing user's display name for diagnostics.
   */
  handleTyping(channelId: string, userId: string, username: string): void {
    if (this.mode === "sleeping" || this.mode === "dreaming") return;

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

  /**
   * Returns the channel containing the active conversation.
   *
   * @returns The active Discord channel, or undefined while sleeping.
   */
  getActiveChannelId(): string | undefined {
    return this.activeChannelId;
  }

  /**
   * Returns the human whose message initiated the current model turn.
   *
   * @returns The first human in the batch currently invoking tools, if any.
   */
  getActiveCreator(): ActiveConversationUser | undefined {
    return this.activeCreator === undefined ? undefined : { ...this.activeCreator };
  }

  /**
   * Adds successful bot output to a channel's bounded recent context.
   *
   * @param message - Successfully delivered bot message with its real Discord identifier.
   */
  recordBotMessage(message: HumanMessage): void {
    this.rememberMessage(message);
    if (message.channelId === this.activeChannelId) this.activeMessageIds.add(message.id);
    const queued = this.queuedWakes.find((wake) => wake.channelId === message.channelId);
    if (queued !== undefined) queued.messages.push(message);
  }

  /**
   * Checks whether a Discord message identifier is present in the active transcript.
   *
   * @param messageId - Candidate target emitted by the model.
   * @returns Whether the current conversation exposed that exact message.
   */
  isMessageInActiveConversation(messageId: string): boolean {
    return this.activeMessageIds.has(messageId);
  }

  /**
   * Acquires the dreaming state when no conversation is active.
   *
   * @returns Whether the session transitioned from sleeping to dreaming.
   */
  beginDreaming(): boolean {
    if (this.mode !== "sleeping") return false;
    this.mode = "dreaming";
    this.logger.info("session.dreaming_started");
    return true;
  }

  /** Ends dreaming and promotes the oldest ping queued while consolidation ran. */
  finishDreaming(): void {
    if (this.mode !== "dreaming") return;
    this.mode = "sleeping";
    this.logger.info("session.dreaming_finished", { queuedChannels: this.queuedWakes.length });
    this.promoteQueuedWake();
  }

  /** Starts a conversation from a human ping or autonomous task wake. */
  private activateWake(wake: QueuedWake): void {
    this.mode = "awake";
    this.activeChannelId = wake.channelId;
    this.pendingBatch = wake.messages;
    this.pendingRecentContext = wake.recentContext;
    this.activeMessageIds = new Set(
      [...wake.recentContext, ...wake.messages].map((message) => message.id),
    );
    this.queuedDuringProcessing = [];
    this.history = [];
    this.activeTaskWake = wake.kind === "task" ? wake : undefined;
    this.taskPromptPending = wake.kind === "task";
    if (wake.kind === "task" && !this.lastMessageAt.has(wake.channelId)) {
      this.lastMessageAt.set(wake.channelId, Date.now());
    }
    this.presence.setPresence({ status: "online" });
    this.logger.info("session.wake", {
      channelId: wake.channelId,
      source: wake.kind,
      messages: wake.messages.length,
    });
    if (wake.kind === "task") void this.startTaskWake(wake);
    else this.scheduleDebounce();
    this.resetIdleTimer();
  }

  /** Sends the visible start line before allowing the task's first model turn. */
  private async startTaskWake(wake: TaskWake): Promise<void> {
    this.taskStarting = true;
    await this.transport
      .sendMessage(wake.channelId, `> ⏰ Ben is starting task ${JSON.stringify(wake.task.name)}...`)
      .catch((error: unknown) => {
        this.logger.warn("tasks.start_status_failed", { id: wake.task.id, error: String(error) });
      });
    this.taskStarting = false;
    if (this.activeTaskWake === wake && this.mode === "awake") this.scheduleDebounce();
  }

  /** Schedules processing after both message and typing activity settle. */
  private scheduleDebounce(): void {
    if (this.taskStarting) return;
    const channelId = this.activeChannelId;
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
    const channelId = this.activeChannelId;
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
    if (this.mode !== "awake" || (this.pendingBatch.length === 0 && !this.taskPromptPending))
      return;

    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const messages = this.pendingBatch;
    const recentContext = this.pendingRecentContext;
    const channelId = this.activeChannelId;
    const taskWake = this.taskPromptPending ? this.activeTaskWake : undefined;
    this.taskPromptPending = false;
    this.pendingBatch = [];
    this.pendingRecentContext = [];
    this.mode = "processing";
    const creator = taskWake === undefined ? messages[0] : undefined;
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
    const memories = includeFirstPromptContext
      ? ((await this.persistence.memories?.list().catch((error: unknown) => {
          this.logger.warn("memories.read_failed", { error: String(error) });
          return [];
        })) ?? [])
      : [];
    const longTermMemory = includeFirstPromptContext
      ? await this.persistence.longTermMemory?.get().catch((error: unknown) => {
          this.logger.warn("long_term_memory.read_failed", { error: String(error) });
          return undefined;
        })
      : undefined;
    const currentBotTime = this.promptContext.getCurrentBotTime?.();
    const currentCustomStatus =
      this.persistence.customStatus === undefined
        ? undefined
        : ((await this.persistence.customStatus.get().catch((error: unknown) => {
            this.logger.warn("custom_status.read_failed", { error: String(error) });
            return undefined;
          })) ?? null);
    const prompt = buildUserPrompt({
      recentContext,
      messages,
      knownPeople,
      includeKnownPeople: includeFirstPromptContext,
      recentConversationSummaries,
      memories,
      ...(currentBotTime === undefined ? {} : { currentBotTime }),
      ...(includeFirstPromptContext && messages[0]?.channelName !== undefined
        ? { currentChannelName: messages[0].channelName }
        : includeFirstPromptContext && taskWake !== undefined
          ? { currentChannelName: taskWake.task.destination.channelName }
          : {}),
      ...(currentCustomStatus === undefined ? {} : { currentCustomStatus }),
      ...(longTermMemory === undefined ? {} : { longTermMemory }),
      ...(includeFirstPromptContext && messages[0] !== undefined
        ? { pingedByUsername: messages[0].username }
        : {}),
      ...(taskWake === undefined ? {} : { task: taskWake.task }),
    });
    try {
      const outcome = await this.orchestrator
        .run(this.instructions, this.history, prompt)
        .catch((error: unknown): ConversationOutcome => ({ type: "failed", error }));
      await this.applyOutcome(outcome, channelId);
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
  ): Promise<void> {
    if (outcome.type === "sleep") {
      await this.persistence.summaries?.add(outcome.summary).catch((error: unknown) => {
        this.logger.warn("conversation_summaries.write_failed", { error: String(error) });
      });
      this.goToSleep("model");
      return;
    }

    if (outcome.type === "reply") {
      await this.deliverOptionalMessage(channelId, outcome.text);
      this.history = [...outcome.history];
    } else if (outcome.type === "wait") {
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

  /** Resets the automatic sleep timer while the session is awake. */
  private resetIdleTimer(): void {
    if (this.mode === "sleeping" || this.mode === "dreaming" || this.mode === "processing") return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.goToSleep("idle"), this.timings.idleSleepMs);
  }

  /** Clears conversation memory, then promotes the oldest queued channel. */
  private goToSleep(reason: "model" | "idle"): void {
    const completedTask = this.activeTaskWake;
    this.clearTimers();
    this.mode = "sleeping";
    this.activeChannelId = undefined;
    this.pendingBatch = [];
    this.pendingRecentContext = [];
    this.queuedDuringProcessing = [];
    this.history = [];
    this.activeMessageIds.clear();
    this.activeCreator = undefined;
    this.activeTaskWake = undefined;
    this.taskPromptPending = false;
    this.taskStarting = false;
    this.typingByChannel.clear();
    this.presence.setPresence({ status: "idle" });
    this.logger.info("session.sleep", { reason, queuedChannels: this.queuedWakes.length });

    if (completedTask !== undefined) {
      void completedTask.complete().catch((error: unknown) => {
        this.logger.warn("tasks.completion_callback_failed", {
          id: completedTask.task.id,
          error: String(error),
        });
      });
    }

    this.promoteQueuedWake();
  }

  /** Promotes the oldest queued ping into a fresh conversation. */
  private promoteQueuedWake(): void {
    const next = this.queuedWakes.shift();
    if (next !== undefined) this.activateWake(next);
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
