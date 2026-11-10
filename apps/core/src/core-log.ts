/**
 * core.log lines. Core's stdout and stderr are redirected to JERRY_HOME/logs/core.log by whoever
 * started it, so every line Core writes starts with its time: an ended Core can then be matched with
 * what happened on the machine at that moment. Writes to a file are synchronous in Node, so a line
 * written right before process.exit is not lost.
 */

/** One log entry: the ISO time, then the message; further lines (a stack) are indented under it. */
export function formatLogLine(message: string, at: Date = new Date()): string {
  const [first = '', ...rest] = message.replace(/\s+$/, '').split(/\r?\n/);
  return [`${at.toISOString()} ${first}`, ...rest.map((line) => `    ${line}`)].join('\n') + '\n';
}

export function log(message: string): void {
  process.stdout.write(formatLogLine(message));
}

export function logError(message: string): void {
  process.stderr.write(formatLogLine(message));
}

/** An error with its stack when there is one (the stack starts with the message). */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
