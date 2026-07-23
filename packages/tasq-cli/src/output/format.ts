/**
 * Output formatting — human-readable text + colors when TTY.
 *
 * Single low-overhead formatter ; no external dep on chalk/ansi-colors.
 */

import { shortId, systemClock, type Clock } from "@tasq-run/schema";

export { shortId };

const isTty = process.stdout.isTTY === true;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function ansi(code: keyof typeof ANSI, s: string): string {
  if (!isTty) return s;
  return `${ANSI[code]}${s}${ANSI.reset}`;
}

export const color = {
  bold: (s: string) => ansi("bold", s),
  dim: (s: string) => ansi("dim", s),
  red: (s: string) => ansi("red", s),
  green: (s: string) => ansi("green", s),
  yellow: (s: string) => ansi("yellow", s),
  blue: (s: string) => ansi("blue", s),
  magenta: (s: string) => ansi("magenta", s),
  cyan: (s: string) => ansi("cyan", s),
  gray: (s: string) => ansi("gray", s),
};

const STATUS_COLORS: Record<string, (s: string) => string> = {
  open: color.cyan,
  in_progress: color.blue,
  blocked: color.yellow,
  done: color.green,
  cancelled: color.gray,
  active: color.cyan,
  paused: color.yellow,
  abandoned: color.gray,
  waiting: color.yellow,
};

export function colorizeStatus(status: string): string {
  const fn = STATUS_COLORS[status] ?? ((s: string) => s);
  return fn(status);
}

export function formatRelative(
  targetMs: number,
  nowOrClock: number | Clock = systemClock,
): string {
  const nowMs = typeof nowOrClock === "number" ? nowOrClock : nowOrClock.now();
  const diffMs = targetMs - nowMs;
  const absMs = Math.abs(diffMs);
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  if (absMs < MIN) return "just now";
  if (absMs < HOUR) return formatUnit(diffMs, MIN, "m");
  if (absMs < DAY) return formatUnit(diffMs, HOUR, "h");
  return formatUnit(diffMs, DAY, "d");
}

function formatUnit(diffMs: number, unitMs: number, suffix: string): string {
  const n = Math.round(diffMs / unitMs);
  if (n === 0) return "now";
  if (n > 0) return `in ${n}${suffix}`;
  return `${-n}${suffix} ago`;
}

export function printError(msg: string): void {
  process.stderr.write(color.red(`tasq: ${msg}\n`));
}

export function printWarn(msg: string): void {
  process.stderr.write(color.yellow(`tasq: ${msg}\n`));
}

export function printInfo(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function printJson(value: unknown): void {
  // The historical CLI is an exact v1 contract. Universal collaboration
  // fields are available through the embedded kernel, but remain hidden from
  // v1 task/agentic/event JSON until an explicit CLI v2 is negotiated.
  process.stdout.write(JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const record = candidate as Record<string, unknown>;
    if ("completionMode" in record && "status" in record && "revision" in record) {
      const { revision: _revision, ...v1 } = record;
      return v1;
    }
    if (!("resourceKey" in record) && "actor" in record && "principalId" in record && (
      "eventType" in record || "fence" in record || "runtime" in record || "observedAt" in record
    )) {
      const { principalId: _principalId, revision: _revision, ...v1 } = record;
      return v1;
    }
    return candidate;
  }, 2) + "\n");
}
