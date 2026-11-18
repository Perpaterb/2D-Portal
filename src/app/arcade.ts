// Where this browser keeps the player's name (see player.ts).

const LAST_NAME_KEY = '2dholes.name';

export function lastName(): string {
  try {
    return localStorage.getItem(LAST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(LAST_NAME_KEY, name);
  } catch {
    /* ignore */
  }
}
