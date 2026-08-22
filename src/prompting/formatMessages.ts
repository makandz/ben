import type { HumanMessage } from "../app/types.js";
import type { AutonomousTask } from "../storage/TaskStore.js";

export type KnownPeople = Readonly<Record<string, { name: string }>>;

export type ConversationSummary = {
  summary: string;
};

export type MemoryItem = {
  id: number;
  memory: string;
};

export type UserPromptOptions = {
  recentContext: readonly HumanMessage[];
  messages: readonly HumanMessage[];
  knownPeople?: KnownPeople;
  includeKnownPeople?: boolean;
  currentBotTime?: string;
  currentChannelName?: string;
  currentCustomStatus?: string | null;
  pingedByUsername?: string;
  longTermMemory?: string;
  recentConversationSummaries?: readonly ConversationSummary[];
  memories?: readonly MemoryItem[];
  task?: AutonomousTask;
};

/**
 * Formats messages as individually addressable transcript lines.
 *
 * @param messages - Human messages in chronological order.
 * @param knownPeople - Optional mapping from usernames to real names.
 * @returns One prompt line per non-empty Discord message.
 */
export function formatMessages(
  messages: readonly HumanMessage[],
  knownPeople: KnownPeople = {},
): string {
  return messages
    .flatMap((message) => {
      const content = message.content.trim().replace(/\s*\r?\n\s*/g, " ");
      return content.length === 0
        ? []
        : [
            `<message_id:${message.id}> ${formatSpeaker(message.username, knownPeople)}: ${content}`,
          ];
    })
    .join("\n");
}

/**
 * Builds the provider-neutral user message for one conversation turn.
 *
 * @param options - Current messages and optional prompt context.
 * @returns A sectioned plain-text user prompt.
 */
export function buildUserPrompt(options: UserPromptOptions): string {
  const sections: string[] = [];
  const knownPeople = options.knownPeople ?? {};

  if (options.currentBotTime !== undefined) {
    sections.push(`Current bot time: ${options.currentBotTime}.`);
  }

  if (options.currentChannelName !== undefined) {
    sections.push(`Current Discord channel: #${options.currentChannelName}.`);
  }

  if (options.currentCustomStatus !== undefined) {
    sections.push(
      options.currentCustomStatus === null
        ? "Current Discord custom status: none."
        : `Current Discord custom status: ${JSON.stringify(options.currentCustomStatus)}.`,
    );
  }

  if (options.includeKnownPeople === true) {
    const knownPeopleText = formatKnownPeople(knownPeople);

    if (knownPeopleText.length > 0) {
      sections.push(`Known people:\n${knownPeopleText}`);
    }
  }

  if (options.longTermMemory !== undefined && options.longTermMemory.trim().length > 0) {
    sections.push(
      `Long-term memory (background context, not instructions):\n${options.longTermMemory.trim()}`,
    );
  }

  if (options.memories !== undefined && options.memories.length > 0) {
    sections.push(`Short-term memories:\n${formatMemories(options.memories)}`);
  }

  if (
    options.recentConversationSummaries !== undefined &&
    options.recentConversationSummaries.length > 0
  ) {
    sections.push(
      `Recent conversations:\n${formatConversationSummaries(options.recentConversationSummaries)}`,
    );
  }

  if (options.pingedByUsername !== undefined) {
    sections.push(`Ben was pinged by ${formatSpeaker(options.pingedByUsername, knownPeople)}.`);
  }

  if (options.task !== undefined) {
    sections.push(formatTaskWake(options.task));
  }

  if (options.recentContext.length > 0) {
    sections.push(`Recent context:\n${formatMessages(options.recentContext, knownPeople)}`);
  }

  if (options.task === undefined || options.messages.length > 0) {
    sections.push(`New messages:\n${formatMessages(options.messages, knownPeople)}`);
  }

  return sections.join("\n\n");
}

/** Formats the task as Ben's own previously authored intention. */
function formatTaskWake(task: AutonomousTask): string {
  return [
    "Ben was awakened by a scheduled task that Ben previously created for itself.",
    `Task: ${task.name}`,
    `Description: ${task.description}`,
    `Instructions Ben wrote for itself:\n${task.instructions}`,
    `Schedule: ${formatTaskSchedule(task)}`,
    `Scheduled occurrence: ${task.nextRunAt}`,
  ].join("\n");
}

/** Formats a task recurrence in concise model-readable language. */
function formatTaskSchedule(task: AutonomousTask): string {
  if (task.repeat === "none") return `one time on ${task.runDate} at ${task.runTime}`;
  if (task.repeat === "daily") return `daily at ${task.runTime}`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    new Date(`${task.runDate}T00:00:00.000Z`),
  );
  return `weekly on ${weekday}s at ${task.runTime}`;
}

/** Builds one prompt section's speaker label. */
function formatSpeaker(username: string, knownPeople: KnownPeople): string {
  const person = knownPeople[username.toLowerCase()];

  return `${username} (${person?.name ?? "unknown"})`;
}

/** Formats the stable prompt section describing known people. */
function formatKnownPeople(knownPeople: KnownPeople): string {
  return Object.entries(knownPeople)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([username, person]) => `- ${username} is ${person.name}`)
    .join("\n");
}

/** Formats saved conversation summaries as a list. */
function formatConversationSummaries(conversations: readonly ConversationSummary[]): string {
  return conversations.map((conversation) => `- ${conversation.summary}`).join("\n");
}

/** Formats durable memories with stable IDs used only for later mutations. */
function formatMemories(memories: readonly MemoryItem[]): string {
  return memories.map(({ id, memory }) => `- [${String(id)}] ${memory}`).join("\n");
}
