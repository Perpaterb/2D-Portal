// Leaderboard rules shared by the game and the server.

export const NAME_LENGTH = 8;
/** Characters an arcade name can use, in the order the up / down keys cycle through them. */
export const NAME_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._';
/** Longest run the leaderboard accepts: five minutes. */
export const MAX_RUN_TICKS = 5 * 60 * 60;
export const TOP_COUNT = 10;

/** Upper-cases, drops unknown characters, trims; null when nothing usable is left. */
export function normaliseName(raw: string): string | null {
  const up = [...String(raw ?? '').toUpperCase()].filter((c) => NAME_CHARS.includes(c)).join('');
  const name = up.trim().slice(0, NAME_LENGTH).trim();
  return name.length ? name : null;
}
