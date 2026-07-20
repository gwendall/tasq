import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { systemClock, type Clock } from "@tasq/schema";

export const JOURNAL_CHECKPOINT_TYPE = "tasq.journal.checkpoint";

export interface JournalSegmentRef {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface JournalCheckpointV1 {
  recordType: typeof JOURNAL_CHECKPOINT_TYPE;
  version: 1;
  tenantId: string;
  databaseCursor: number;
  databaseEventId: string | null;
  previousSegment: JournalSegmentRef | null;
  actor: string;
  reason: string;
  createdAt: number;
}

export interface CheckpointResult {
  checkpoint: JournalCheckpointV1;
  archivePath: string | null;
  reused: boolean;
}

export interface ArchiveChainVerification {
  ok: boolean;
  segments: number;
  issues: string[];
}

/** Parse only the checkpoint record; domain events deliberately return null. */
export function parseJournalCheckpoint(value: unknown): JournalCheckpointV1 | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.recordType !== JOURNAL_CHECKPOINT_TYPE || row.version !== 1) return null;
  const previous = row.previousSegment;
  const validPrevious = previous === null || (
    typeof previous === "object" && previous !== null &&
    typeof (previous as Record<string, unknown>).path === "string" &&
    typeof (previous as Record<string, unknown>).sha256 === "string" &&
    /^[0-9a-f]{64}$/.test((previous as Record<string, unknown>).sha256 as string) &&
    typeof (previous as Record<string, unknown>).sizeBytes === "number" &&
    Number.isSafeInteger((previous as Record<string, unknown>).sizeBytes) &&
    ((previous as Record<string, unknown>).sizeBytes as number) >= 0
  );
  if (
    typeof row.tenantId !== "string" || row.tenantId.length === 0 ||
    typeof row.databaseCursor !== "number" ||
    !Number.isSafeInteger(row.databaseCursor) || row.databaseCursor < 0 ||
    !(row.databaseEventId === null || typeof row.databaseEventId === "string") ||
    typeof row.actor !== "string" || row.actor.length === 0 ||
    typeof row.reason !== "string" || row.reason.trim().length === 0 ||
    typeof row.createdAt !== "number" ||
    !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
    !validPrevious
  ) return null;
  return row as unknown as JournalCheckpointV1;
}

export function readLeadingCheckpoint(path: string): JournalCheckpointV1 | null {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, "utf8").split("\n").find((line) => line.trim().length > 0);
  if (!first) return null;
  try {
    return parseJournalCheckpoint(JSON.parse(first));
  } catch {
    return null;
  }
}

/**
 * Append one committed event under the same filesystem lock used by segment
 * rotation. A delayed listener may observe a freshly written checkpoint; if
 * the DB cursor already covers its event, appending it would put a pre-baseline
 * event in the new segment, so it is safely skipped.
 */
export type JournalAppendResult = "appended" | "already_present" | "covered_by_checkpoint";

export function appendJournalEvent(
  path: string,
  event: { id: string; sequence: number },
  clock: Clock = systemClock,
): JournalAppendResult {
  return withJournalLock(path, () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const checkpoint = readLeadingCheckpoint(path);
    if (checkpoint && event.sequence <= checkpoint.databaseCursor) return "covered_by_checkpoint";

    let maxSequence = checkpoint?.databaseCursor ?? 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error("Journal contains malformed JSON; refusing append until doctor repair");
        }
        const row = parsed as { id?: unknown; sequence?: unknown; recordType?: unknown };
        if (row.recordType === JOURNAL_CHECKPOINT_TYPE) continue;
        if (typeof row.id !== "string" || row.id.length === 0) {
          throw new Error("Journal contains a record without an event id; refusing append");
        }
        if (row.id === event.id) {
          if (row.sequence === event.sequence) return "already_present";
          throw new Error(`Journal event ${event.id} exists with another sequence`);
        }
        if (typeof row.sequence === "number" && Number.isSafeInteger(row.sequence)) {
          if (row.sequence === event.sequence) {
            throw new Error(`Journal sequence ${event.sequence} belongs to another event`);
          }
          maxSequence = Math.max(maxSequence, row.sequence);
        }
      }
    }
    if (event.sequence <= maxSequence) {
      throw new Error(
        `Journal append would be out of order: event ${event.sequence}, current ${maxSequence}`,
      );
    }
    appendFileSync(path, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
    return "appended";
  }, clock);
}

/**
 * Accept the current DB cursor as authoritative, preserving the complete old
 * journal as a content-addressed segment and atomically installing a new
 * checkpoint-led segment. Repeating immediately returns the same checkpoint.
 */
export function checkpointJournal(options: {
  path: string;
  tenantId: string;
  databaseCursor: number;
  databaseEventId: string | null;
  actor: string;
  reason: string;
  now?: number;
  clock?: Clock;
}): CheckpointResult {
  return withJournalLock(options.path, () => {
    const existing = readLeadingCheckpoint(options.path);
    const content = existsSync(options.path) ? readFileSync(options.path, "utf8") : "";
    const nonEmptyLines = content.split("\n").filter((line) => line.trim().length > 0);
    if (
      existing &&
      existing.tenantId === options.tenantId &&
      existing.databaseCursor === options.databaseCursor &&
      existing.databaseEventId === options.databaseEventId &&
      nonEmptyLines.length === 1
    ) {
      return {
        checkpoint: existing,
        archivePath: existing.previousSegment
          ? resolveSegmentPath(options.path, existing.previousSegment.path)
          : null,
        reused: true,
      };
    }

    const createdAt = options.now ?? (options.clock ?? systemClock).now();
    const previousSegment = content.length > 0
      ? segmentRefFor(options.path, content, createdAt, options.databaseCursor)
      : null;
    const checkpoint: JournalCheckpointV1 = {
      recordType: JOURNAL_CHECKPOINT_TYPE,
      version: 1,
      tenantId: options.tenantId,
      databaseCursor: options.databaseCursor,
      databaseEventId: options.databaseEventId,
      previousSegment: previousSegment?.ref ?? null,
      actor: options.actor,
      reason: options.reason.trim(),
      createdAt,
    };

    const dir = dirname(options.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const temporary = join(dir, `.${basename(options.path)}.checkpoint-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(checkpoint) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    const temporaryFd = openSync(temporary, "r");
    try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }

    let archived = false;
    try {
      if (previousSegment) {
        mkdirSync(dirname(previousSegment.absolutePath), { recursive: true, mode: 0o700 });
        chmodSync(dirname(previousSegment.absolutePath), 0o700);
        renameSync(options.path, previousSegment.absolutePath);
        archived = true;
      }
      renameSync(temporary, options.path);
      chmodSync(options.path, 0o600);
      try {
        const dirFd = openSync(dir, "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } catch { /* rollback below still prevents silent segment loss */ }
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (archived && previousSegment && !existsSync(options.path)) {
        renameSync(previousSegment.absolutePath, options.path);
      }
      throw error;
    }

    return {
      checkpoint,
      archivePath: previousSegment?.absolutePath ?? null,
      reused: false,
    };
  }, options.clock ?? systemClock);
}

export function resolveSegmentPath(journalPath: string, segmentPath: string): string {
  const root = resolve(dirname(journalPath));
  const target = resolve(root, segmentPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || resolve(root, rel) !== target) {
    throw new Error(`Journal checkpoint archive escapes journal directory: ${segmentPath}`);
  }
  return target;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Verify every content-addressed predecessor reachable from a checkpoint. */
export function verifyJournalArchiveChain(
  journalPath: string,
  checkpoint: JournalCheckpointV1,
): ArchiveChainVerification {
  const seen = new Set<string>();
  const issues: string[] = [];
  let segments = 0;
  let cursor: JournalCheckpointV1 | null = checkpoint;
  while (cursor?.previousSegment) {
    let archive: string;
    try {
      archive = resolveSegmentPath(journalPath, cursor.previousSegment.path);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      break;
    }
    if (seen.has(archive)) {
      issues.push(`journal archive chain contains a cycle at ${archive}`);
      break;
    }
    seen.add(archive);
    if (!existsSync(archive)) {
      issues.push(`journal archive is missing: ${archive}`);
      break;
    }
    if (
      statSync(archive).size !== cursor.previousSegment.sizeBytes ||
      sha256File(archive) !== cursor.previousSegment.sha256
    ) {
      issues.push(`journal archive does not match its size/SHA-256: ${archive}`);
      break;
    }
    segments++;
    cursor = readLeadingCheckpoint(archive);
  }
  return { ok: issues.length === 0, segments, issues };
}

function segmentRefFor(journalPath: string, content: string, now: number, cursor: number): {
  ref: JournalSegmentRef;
  absolutePath: string;
} {
  const digest = createHash("sha256").update(content).digest("hex");
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const name = `events-${stamp}-through-${cursor}-${digest.slice(0, 12)}.jsonl`;
  const rel = join("journal-archive", name);
  return {
    ref: { path: rel, sha256: digest, sizeBytes: Buffer.byteLength(content) },
    absolutePath: resolveSegmentPath(journalPath, rel),
  };
}

function withJournalLock<T>(journalPath: string, fn: () => T, clock: Clock): T {
  const lockPath = `${journalPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  // Bound contention by attempts, not clock progress: a deliberately frozen
  // simulation clock must never turn a lock timeout into an infinite loop.
  let remainingAttempts = 500;
  let fd: number | null = null;
  while (fd == null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (clock.now() - statSync(lockPath).mtimeMs > 60_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      remainingAttempts--;
      if (remainingAttempts <= 0) {
        throw new Error(`Timed out waiting for journal lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* stale-lock recovery handles this */ }
  }
}
