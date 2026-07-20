/** Read a wrapped error without depending on one ORM or database driver. */
export function errorChainMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    if (typeof current !== "object") {
      messages.push(String(current));
      break;
    }

    const record = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const message = typeof record.message === "string" ? record.message : "";
    const code = typeof record.code === "string" || typeof record.code === "number"
      ? String(record.code)
      : "";
    const name = typeof record.name === "string" ? record.name : "";
    const label = code && !message.includes(code)
      ? `${code}: ${message || name || "error"}`
      : message || code || name;
    if (label) messages.push(label);
    current = record.cause;
  }

  return messages;
}

/** Prefer the driver's semantic cause over an ORM query wrapper. */
export function errorMessage(error: unknown): string {
  const messages = errorChainMessages(error);
  return messages.at(-1) ?? String(error);
}

/** Match every wrapper and cause, including structured driver error codes. */
export function errorMatches(error: unknown, expected: RegExp): boolean {
  return errorChainMessages(error).some((message) => {
    const stablePattern = new RegExp(expected.source, expected.flags.replace(/[gy]/g, ""));
    return stablePattern.test(message);
  });
}
