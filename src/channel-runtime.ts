import type { AgentInputItem } from "@openai/agents";

const SLEEP_QUEUE_MAX = 50;
const AWAKE_QUEUE_MAX = 200;
const AWAKE_QUEUE_RETAIN_COUNT = 50;

export type ConversationMode = "sleep" | "awake";

export type ChannelRuntimeState = {
  history: AgentInputItem[];
  mode: ConversationMode;
  lastActivityAt: number;
  lastMessageAt: number;
  lastMessageId?: string;
  lastRequestingUserId?: string;
  clearTimer?: NodeJS.Timeout;
  responseTimer?: NodeJS.Timeout;
  typingExpirations: Map<string, number>;
};

/**
 * Stores per-channel conversation state and serializes agent work by channel.
 *
 * @returns Helpers for managing message history, mode, timers, typing state, and queued work.
 */
export function createChannelRuntime() {
  const channels = new Map<string, ChannelRuntimeState>();
  const channelQueues = new Map<string, Promise<void>>();

  return {
    ensureChannel(channelId: string): ChannelRuntimeState {
      const existing = channels.get(channelId);

      if (existing) {
        return existing;
      }

      const state: ChannelRuntimeState = {
        history: [],
        mode: "sleep",
        lastActivityAt: 0,
        lastMessageAt: 0,
        typingExpirations: new Map<string, number>(),
      };

      channels.set(channelId, state);
      return state;
    },

    getChannel(channelId: string): ChannelRuntimeState | undefined {
      return channels.get(channelId);
    },

    clearChannel(channelId: string): void {
      const state = channels.get(channelId);

      if (!state) {
        return;
      }

      clearOptionalTimer(state.responseTimer);
      clearOptionalTimer(state.clearTimer);
      channels.delete(channelId);
    },

    countAwakeChannels(): number {
      let awakeChannels = 0;

      for (const state of channels.values()) {
        if (state.mode === "awake") {
          awakeChannels += 1;
        }
      }

      return awakeChannels;
    },

    recordMessage(
      channelId: string,
      message: AgentInputItem,
      metadata: {
        createdAt: number;
        messageId: string;
        userId: string;
      },
    ): ChannelRuntimeState {
      const state = this.ensureChannel(channelId);

      state.history.push(message);
      state.lastActivityAt = metadata.createdAt;
      state.lastMessageAt = metadata.createdAt;
      state.lastMessageId = metadata.messageId;
      state.lastRequestingUserId = metadata.userId;

      trimHistory(state);
      return state;
    },

    recordAssistantMessage(
      channelId: string,
      message: AgentInputItem,
      createdAt: number,
    ): ChannelRuntimeState {
      const state = this.ensureChannel(channelId);

      state.history.push(message);
      state.lastActivityAt = createdAt;

      trimHistory(state);
      return state;
    },

    recordTyping(
      channelId: string,
      userId: string,
      expiresAt: number,
      startedAt: number,
    ): ChannelRuntimeState {
      const state = this.ensureChannel(channelId);

      state.typingExpirations.set(userId, expiresAt);
      state.lastActivityAt = Math.max(state.lastActivityAt, startedAt);
      pruneExpiredTyping(state, startedAt);
      return state;
    },

    getHistory(channelId: string): AgentInputItem[] {
      return this.ensureChannel(channelId).history;
    },

    getMode(channelId: string): ConversationMode {
      return this.ensureChannel(channelId).mode;
    },

    setMode(channelId: string, mode: ConversationMode): ChannelRuntimeState {
      const state = this.ensureChannel(channelId);
      state.mode = mode;
      trimHistory(state);
      return state;
    },

    trimHistoryToCurrentMode(channelId: string): void {
      trimHistory(this.ensureChannel(channelId));
    },

    setResponseTimer(
      channelId: string,
      timer: NodeJS.Timeout | undefined,
    ): ChannelRuntimeState {
      const state = this.ensureChannel(channelId);
      clearOptionalTimer(state.responseTimer);
      state.responseTimer = timer;
      return state;
    },

    clearResponseTimer(channelId: string): void {
      const state = channels.get(channelId);

      if (!state) {
        return;
      }

      clearOptionalTimer(state.responseTimer);
      state.responseTimer = undefined;
    },

    setClearTimer(
      channelId: string,
      timer: NodeJS.Timeout | undefined,
    ): ChannelRuntimeState {
      const state = this.ensureChannel(channelId);
      clearOptionalTimer(state.clearTimer);
      state.clearTimer = timer;
      return state;
    },

    clearTyping(channelId: string): void {
      const state = channels.get(channelId);

      if (!state) {
        return;
      }

      state.typingExpirations.clear();
    },

    getRemainingSilenceMs(channelId: string, now: number, quietMs: number): number {
      const state = channels.get(channelId);

      if (!state) {
        return 0;
      }

      pruneExpiredTyping(state, now);
      const quietSince = Math.max(
        state.lastActivityAt,
        ...state.typingExpirations.values(),
      );

      return Math.max(0, quietSince + quietMs - now);
    },

    queueWork(channelId: string, work: () => Promise<void>): void {
      const previous = channelQueues.get(channelId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(work)
        .finally(() => {
          if (channelQueues.get(channelId) === next) {
            channelQueues.delete(channelId);
          }
        });

      channelQueues.set(channelId, next);
    },
  };
}

/**
 * Trims channel history according to the active conversation mode and overflow policy.
 *
 * @param state - Channel state whose history should be limited in place.
 * @returns Nothing.
 */
function trimHistory(state: ChannelRuntimeState): void {
  if (state.mode === "sleep") {
    if (state.history.length > SLEEP_QUEUE_MAX) {
      state.history = state.history.slice(-SLEEP_QUEUE_MAX);
    }

    return;
  }

  if (state.history.length >= AWAKE_QUEUE_MAX) {
    state.history = state.history.slice(-AWAKE_QUEUE_RETAIN_COUNT);
  }
}

/**
 * Removes expired typing markers so silence checks only consider active typers.
 *
 * @param state - Channel state that may contain stale typing markers.
 * @param now - Current timestamp in milliseconds.
 * @returns Nothing.
 */
function pruneExpiredTyping(state: ChannelRuntimeState, now: number): void {
  for (const [userId, expiresAt] of state.typingExpirations) {
    if (expiresAt <= now) {
      state.typingExpirations.delete(userId);
    }
  }
}

/**
 * Clears a timer when it exists.
 *
 * @param timer - Timer handle to cancel.
 * @returns Nothing.
 */
function clearOptionalTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer) {
    clearTimeout(timer);
  }
}
