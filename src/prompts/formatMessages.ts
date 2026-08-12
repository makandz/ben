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
  currentBotTime?: string;
  currentCustomStatus?: string | null;
  pingedByUsername?: string;
  recentConversationSummaries?: readonly ConversationSummary[];
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

  if (options.recentContext.length > 0) {
    sections.push(`Recent context:\n${formatMessages(options.recentContext, knownPeople)}`);
  }

  sections.push(`New messages:\n${formatMessages(options.messages, knownPeople)}`);

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
