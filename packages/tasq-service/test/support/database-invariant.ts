/**
 * Assert the semantic SQLite failure, even when an ORM adds diagnostic
 * wrappers around the driver error. The complete cause chain is inspected;
 * matching only the outer query text would not prove that the trigger fired.
 */
export async function assertDatabaseInvariantRejected(
  operation: PromiseLike<unknown>,
  expected: string | RegExp,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const messages = errorMessages(error);
    const matches = messages.some((message) => matchesExpected(message, expected));
    if (matches) return;

    const rendered = messages.length > 0 ? messages.join("\ncaused by: ") : String(error);
    throw new Error(`database rejection did not contain ${String(expected)}:\n${rendered}`);
  }

  throw new Error(`database operation resolved; expected rejection containing ${String(expected)}`);
}

function errorMessages(error: unknown): string[] {
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

    const record = current as { message?: unknown; cause?: unknown };
    if (typeof record.message === "string") messages.push(record.message);
    current = record.cause;
  }

  return messages;
}

function matchesExpected(message: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") return message.includes(expected);
  const stablePattern = new RegExp(expected.source, expected.flags.replace(/[gy]/g, ""));
  return stablePattern.test(message);
}
