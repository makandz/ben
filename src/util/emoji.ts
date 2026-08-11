/**
 * Checks whether a value is exactly one standard Unicode emoji grapheme.
 *
 * @param value - Candidate reaction text.
 * @returns Whether the value is one emoji, including joined and flag emoji.
 */
export function isSingleUnicodeEmoji(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];

  if (graphemes.length !== 1) {
    return false;
  }

  return (
    /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}\uFE0F\u200D]+$/u.test(
      value,
    ) || /^\p{Regional_Indicator}{2}$/u.test(value)
  );
}
