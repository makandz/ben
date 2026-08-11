/**
 * Formats a dollar amount with the precision used by usage and budget displays.
 *
 * @param value - Dollar amount to format.
 * @returns The amount with a dollar sign and four fractional digits.
 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
