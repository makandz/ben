const broadcastMentionPattern = /@(?=everyone\b|here\b)/gi;

/**
 * Escapes plain-text Discord broadcast mentions.
 *
 * @param content - Message content that may contain broadcast mentions.
 * @returns Content that cannot notify everyone or online members.
 */
export function escapeBroadcastMentions(content: string): string {
  return content.replace(broadcastMentionPattern, "@\u200B");
}
