import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandActivity } from "../src/commands/usage-report.js";
import { detectHarness, readCommandJournal, recordCommand, redactMessage } from "../src/command-journal.js";

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
  actor: "claude:main",
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
      .toBe("attempt not found: <id>");
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
