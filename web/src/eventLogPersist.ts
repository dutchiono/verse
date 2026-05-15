/** Persisted client-side only; cleared on lock. */

const KEY_LOG = "trading-machine:event-log:v1";
const KEY_FILTER = "trading-machine:event-filter:v1";
const MAX_LINES = 500;

export interface PersistedLogLine {
  ts: number;
  text: string;
  level?: "info" | "warn" | "ok";
}

function isLine(x: unknown): x is PersistedLogLine {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.ts === "number" && typeof o.text === "string";
}

export function loadPersistedLog(): PersistedLogLine[] {
  try {
    const raw = localStorage.getItem(KEY_LOG);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLine).slice(-MAX_LINES);
  } catch {
    return [];
  }
}

export function savePersistedLog(lines: PersistedLogLine[]): void {
  try {
    const capped = lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
    localStorage.setItem(KEY_LOG, JSON.stringify(capped));
  } catch {
    /* quota / private mode */
  }
}

export function clearPersistedEventLog(): void {
  try {
    localStorage.removeItem(KEY_LOG);
    localStorage.removeItem(KEY_FILTER);
  } catch {
    /* ignore */
  }
}

export function loadEventsFilter(): string {
  try {
    return localStorage.getItem(KEY_FILTER) ?? "";
  } catch {
    return "";
  }
}

export function saveEventsFilter(filter: string): void {
  try {
    if (filter.trim()) localStorage.setItem(KEY_FILTER, filter);
    else localStorage.removeItem(KEY_FILTER);
  } catch {
    /* ignore */
  }
}
