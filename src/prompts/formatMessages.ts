import type { HumanMessage } from "../app/types.js";

export type KnownPeople = Readonly<Record<string, { name: string }>>;

export type ConversationSummary = {
  summary: string;
};

export type UserPromptOptions = {
  recentContext: readonly HumanMessage[];
  messages: readonly HumanMessage[];
  knownPeople?: KnownPeople;
  includeKnownPeople?: boolean;
  currentActivityStatus?: string;
  currentBotTime?: string;
  pingedByUsername?: string;
  recentConversationSummaries?: readonly ConversationSummary[];
};

/**
 * Groups consecutive messages from the same speaker.
 *
 * @param messages - Human messages in chronological order.
 * @param knownPeople - Optional mapping from usernames to real names.
 * @returns One prompt line per consecutive raw username.
 */
export function formatGroupedMessages(
  messages: readonly HumanMessage[],
  knownPeople: KnownPeople = {},
): string {
  const lines: string[] = [];
  let currentUsername: string | undefined;
  let currentContent: string[] = [];

  for (const message of messages) {
    const content = message.content.trim();

    if (content.length === 0) {
      continue;
    }

    if (message.username !== currentUsername) {
      if (currentUsername !== undefined && currentContent.length > 0) {
        lines.push(`${formatSpeaker(currentUsername, knownPeople)}: ${currentContent.join(" ")}`);
      }

      currentUsername = message.username;
      currentContent = [content];
      continue;
    }

    currentContent.push(content);
  }

  if (currentUsername !== undefined && currentContent.length > 0) {
    lines.push(`${formatSpeaker(currentUsername, knownPeople)}: ${currentContent.join(" ")}`);
  }

  return lines.join("\n");
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

  if (options.includeKnownPeople === true) {
    const knownPeopleText = formatKnownPeople(knownPeople);

    if (knownPeopleText.length > 0) {
      sections.push(`Known people:\n${knownPeopleText}`);
    }
  }

  if (options.currentActivityStatus !== undefined) {
    sections.push(`Ben's current activity status is "${options.currentActivityStatus}".`);
  }

  if (options.currentBotTime !== undefined) {
    sections.push(
      `Current bot time: ${options.currentBotTime}. Scheduled message tool dates must be YYYY-MM-DD and times must be 24-hour HH:mm in the bot's local time.`,
    );
  }

  if (options.pingedByUsername !== undefined) {
    sections.push(`Ben was pinged by ${formatSpeaker(options.pingedByUsername, knownPeople)}.`);
  }

  if (
    options.recentConversationSummaries !== undefined &&
    options.recentConversationSummaries.length > 0
  ) {
    sections.push(
      `Recent conversations:\n${formatConversationSummaries(options.recentConversationSummaries)}`,
    );
  }

  if (options.recentContext.length > 0) {
    sections.push(`Recent context:\n${formatGroupedMessages(options.recentContext, knownPeople)}`);
  }

  sections.push(`New messages:\n${formatGroupedMessages(options.messages, knownPeople)}`);

  return sections.join("\n\n");
}

/** Builds one prompt section's speaker label. */
function formatSpeaker(username: string, knownPeople: KnownPeople): string {
  const person = knownPeople[username.toLowerCase()];

  return person === undefined ? username : `${username} (${person.name})`;
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
