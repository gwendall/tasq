import { describe, expect, it, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, chmodSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandActivity } from "../src/commands/usage-report.js";
import { COMMAND_RECORD_CONTRACT, CommandRecord, commandShape, detectHarness, readCommandJournal, recordCommand, redactMessage } from "../src/command-journal.js";

const homes: string[] = [];
const previous = process.env.TASQ_HOME;
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
  if (previous === undefined) delete process.env.TASQ_HOME;
  else process.env.TASQ_HOME = previous;
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "tasq-journal-"));
  homes.push(dir);
  chmodSync(dir, 0o700);
  process.env.TASQ_HOME = dir;
  return dir;
}

const base = {
  recordedAt: 1_800_000_000_000,
  version: "0.6.5",
  space: "tasq/dev",
  command: "capture",
  subcommand: null,
  flags: ["source"],
  exitCode: 1,
  code: null,
  message: "area, goal and project require an injected planning-profile policy",
  durationMs: 12,
};

describe("the private command journal", () => {
  it("records a refusal the ledger cannot, because a refusal writes no event", () => {
    home();
    recordCommand(base);
    const records = readCommandJournal();
    expect(records).toHaveLength(1);
    expect(records[0]!.command).toBe("capture");
    expect(records[0]!.exitCode).toBe(1);
    expect(records[0]!.harness).toBe(detectHarness());
  });

  it("keeps the file private to its owner", () => {
    const dir = home();
    recordCommand(base);
    expect(existsSync(join(dir, "commands.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "commands.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("writes nothing when no Tasq home exists, so cold validation stays zero-mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-journal-absent-"));
    homes.push(dir);
    process.env.TASQ_HOME = join(dir, "never-created");
    recordCommand(base);
    expect(existsSync(join(dir, "never-created"))).toBe(false);
  });

  it("drops identifiers from a message, which are noise in a refusal", () => {
    expect(redactMessage("attempt not found: 01a0822b-ec77-74e0-9999-000000000000"))
      .toBe("attempt not found");
  });

  it("ranks what is refused, which is the list worth acting on", () => {
    const activity = buildCommandActivity([
      { ...base, contractVersion: "tasq.command-record.v1", platform: "darwin", architecture: "arm64", harness: "claude-code" },
      { ...base, contractVersion: "tasq.command-record.v1", platform: "darwin", architecture: "arm64", harness: "claude-code" },
      { ...base, contractVersion: "tasq.command-record.v1", platform: "darwin", architecture: "arm64", harness: "codex", command: "next", exitCode: 0, message: null },
    ]);
    expect(activity.invocations).toBe(3);
    expect(activity.failures).toBe(2);
    expect(activity.failing[0]!.command).toBe("capture");
    expect(activity.failing[0]!.failures).toBe(2);
    // A read leaves no event, so only the journal proves it happened.
    expect(activity.reads.next).toBe(1);
    expect(activity.byHarness.codex).toBe(1);
  });
});

describe("a journal written by a newer Tasq", () => {
  test("keeps every record instead of reporting an empty journal", () => {
    const dir = home();
    // Exactly what a newer release leaves behind: the contract this version
    // knows, plus one field it has never heard of.
    const line = JSON.stringify({
      contractVersion: COMMAND_RECORD_CONTRACT,
      recordedAt: 1_800_000_000_000,
      version: "9.9.9",
      platform: "linux",
      architecture: "x64",
      harness: "codex",
      space: "tasq/dev",
      command: "next",
      subcommand: null,
      flags: ["limit"],
      exitCode: 0,
      code: null,
      message: null,
      durationMs: 7,
      somethingAddedLater: { nested: true },
    });
    writeFileSync(join(dir, "commands.jsonl"), `${line}\n`, { mode: 0o600 });

    const records = readCommandJournal();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ command: "next", version: "9.9.9" });
    expect(records[0]).not.toHaveProperty("somethingAddedLater");
  });

  test("still refuses to WRITE a field this version does not mean to store", () => {
    expect(() => CommandRecord.parse({
      contractVersion: COMMAND_RECORD_CONTRACT,
      recordedAt: 1, version: "0", platform: "linux", architecture: "x64",
      harness: "codex", space: null, command: "next", subcommand: null,
      flags: [], exitCode: 0, code: null, message: null, durationMs: 0,
      actor: "claude:main",
    })).toThrow();
  });
});

describe("what a refusal is allowed to carry", () => {
  test("keeps the authored shape and drops the value the message quotes back", () => {
    // Roughly eighty CLI errors interpolate what the user typed. A secret
    // pasted into --metadata used to land in the file and be printed back by
    // `tasq usage`.
    expect(redactMessage("--metadata must be valid JSON, got: sk-live-not-a-real-key"))
      .toBe("--metadata must be valid JSON, got");
    expect(redactMessage('Unknown flag: --client-acme-internal')).toBe("Unknown flag");
    expect(redactMessage('cannot open "/Users/someone/private/notes.db"')).toBe("cannot open");
    // A message that interpolates nothing survives whole: that is the signal.
    expect(redactMessage("area, goal and project require an injected planning-profile policy"))
      .toBe("area, goal and project require an injected planning-profile policy");
  });

  test("a positional escaped with -- is never stored as a flag name", () => {
    // `--` ends the options. Everything after it is a positional the user
    // escaped BECAUSE it looks like a flag.
    expect(commandShape(["add", "--", "--internal-codename-do-not-leak"]))
      .toMatchObject({ command: "add", flags: [] });
    expect(commandShape(["add", "--because", "x", "--", "-p"]))
      .toMatchObject({ flags: ["because"] });
  });

  test("combined short flags are counted as the flags they are", () => {
    expect(commandShape(["list", "-jf"])).toMatchObject({ flags: ["f", "j"] });
  });
});

describe("what the reads counter can see", () => {
  test("counts a read that lives under a verb, not just a top-level one", () => {
    // `attempt list` and `evidence list` are reads, and a read leaves no ledger
    // event, so the journal is the only place they can be counted. Matching on
    // the top-level verb alone made both invisible and under-reported exactly
    // the commands someone uses while finding their way around a space.
    const activity = buildCommandActivity([
      { ...base, exitCode: 0, message: null, command: "attempt", subcommand: "list" },
      { ...base, exitCode: 0, message: null, command: "attempt", subcommand: "list" },
      { ...base, exitCode: 0, message: null, command: "evidence", subcommand: "list" },
      { ...base, exitCode: 0, message: null, command: "next", subcommand: null },
      // A mutation under the same verb is not a read.
      { ...base, exitCode: 0, message: null, command: "attempt", subcommand: "start" },
    ].map((record) => CommandRecord.parse({
      contractVersion: COMMAND_RECORD_CONTRACT, platform: "darwin", architecture: "arm64", harness: "unknown", ...record,
    })));
    expect(activity.reads).toEqual({ "attempt list": 2, "evidence list": 1, next: 1 });
  });
});

describe("rotating a journal two processes share", () => {
  test("skips rotation rather than racing another writer, and still records", () => {
    // Rotation reads the whole file and renames a rewritten copy over it. Two
    // agents on one machine could both read, both rewrite, and the second
    // rename would drop what the first appended. A held lock means skip.
    const dir = home();
    const path = join(dir, "commands.jsonl");
    const line = `${JSON.stringify(CommandRecord.parse({
      contractVersion: COMMAND_RECORD_CONTRACT, platform: "darwin", architecture: "arm64", harness: "unknown",
      ...base, exitCode: 0, message: null,
    }))}\n`;
    writeFileSync(path, line.repeat(40_000), { mode: 0o600 });
    const before = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    // A live process holds it: this one. The lock names its holder's pid, and
    // a lock whose process is gone is reclaimed rather than honoured.
    writeFileSync(`${path}.rotate.lock`, `${process.pid}\n`, { mode: 0o600 });

    recordCommand({ ...base, exitCode: 0, message: null });

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length, "the record is appended even when rotation is skipped").toBe(before + 1);
    expect(existsSync(`${path}.rotate.lock`), "another process's lock is left alone").toBe(true);
  });

  test("reclaims a lock whose holder is gone instead of wedging forever", () => {
    // A process killed mid-rotation used to leave the lock behind, and a
    // timeout is not available to expire it: an expiry needs a clock, and only
    // systemClock may read the host clock. The pid is the liveness signal.
    const dir = home();
    const path = join(dir, "commands.jsonl");
    const line = `${JSON.stringify(CommandRecord.parse({
      contractVersion: COMMAND_RECORD_CONTRACT, platform: "darwin", architecture: "arm64", harness: "unknown",
      ...base, exitCode: 0, message: null,
    }))}\n`;
    writeFileSync(path, line.repeat(40_000), { mode: 0o600 });
    const before = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    // A pid that cannot be running: pid 0 is not a real process id here.
    writeFileSync(`${path}.rotate.lock`, "999999999\n", { mode: 0o600 });

    recordCommand({ ...base, exitCode: 0, message: null });

    expect(readFileSync(path, "utf8").split("\n").filter(Boolean).length).toBeLessThan(before);
    expect(existsSync(`${path}.rotate.lock`), "the reclaimed lock is released again").toBe(false);
  });

  test("rotates when no other process holds the lock, and releases it", () => {
    const dir = home();
    const path = join(dir, "commands.jsonl");
    const line = `${JSON.stringify(CommandRecord.parse({
      contractVersion: COMMAND_RECORD_CONTRACT, platform: "darwin", architecture: "arm64", harness: "unknown",
      ...base, exitCode: 0, message: null,
    }))}\n`;
    writeFileSync(path, line.repeat(40_000), { mode: 0o600 });
    const before = readFileSync(path, "utf8").split("\n").filter(Boolean).length;

    recordCommand({ ...base, exitCode: 0, message: null });

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThan(before);
    expect(existsSync(`${path}.rotate.lock`), "the lock is released").toBe(false);
  });
});
