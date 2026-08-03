/**
 * Ring-buffered job log.
 *
 * The log lives here rather than in the brain on purpose: the brain is one of
 * the containers being restarted, so it cannot be the thing that remembers what
 * happened during its own restart (Story 7.12, Task 3).
 */

export class RingLog {
  private readonly lines: string[] = [];
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  push(line: string): void {
    for (const part of line.replace(/\r/g, "\n").split("\n")) {
      const text = part.trimEnd();
      if (!text) continue;
      this.lines.push(text);
      if (this.lines.length > this.capacity) {
        this.lines.shift();
        this.dropped++;
      }
    }
  }

  tail(limit = this.capacity): string[] {
    return this.lines.slice(-limit);
  }

  get droppedLines(): number {
    return this.dropped;
  }
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

/** Process log. Plain stdout — `docker compose logs lokyy-updater` is the UI. */
export function log(level: Level, message: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : "";
  const line = `[lokyy-updater] ${new Date().toISOString()} ${level.toUpperCase()} ${message}${payload}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}
