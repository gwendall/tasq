import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const scriptPath = resolve(import.meta.dir, "../../scripts/run-zero-context-agent-certification.ts");

describe("TQ-321 zero-context behavioral harness", () => {
  test("uses isolated native adapters and certifies state instead of final prose", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain('MARKETPLACE = "gwendall/tasq"');
    expect(source).toContain('CODEX_HOME: configDirectory');
    expect(source).toContain('CLAUDE_CONFIG_DIR: configDirectory');
    expect(source).toContain('CLAUDE_CODE_OAUTH_TOKEN: accessToken');
    expect(source).toContain('Claude Code-credentials');
    expect(source).toContain('cleanTemporaryHostConfig: true');
    expect(source).toContain('humanInterventions: 0');
    expect(source).toContain('claudeInvokedTasqSkill');
    expect(source).not.toContain('"claude", "--safe-mode"');
    expect(source).toContain('ledgerPreservedByteForByte');
    expect(source).toContain('staleAuthorityRejected');
    expect(source).toContain('resumedExclusiveCursor');
    expect(source).toContain('completedExplicitlyWithEvidence');
    expect(source).toContain('usedOnlyTrustedExecutable');
    expect(source).not.toContain("TASQ_DB_URL=file:~");
  });

  test("uses the current deterministic CLI artifact location", async () => {
    const behavioral = await readFile(scriptPath, "utf8");
    const legacy = await readFile(
      resolve(import.meta.dir, "../../scripts/run-blind-agent-trials.ts"),
      "utf8",
    );
    expect(behavioral).toContain('"dist", "cli"');
    expect(legacy).toContain('"dist", "cli"');
    expect(legacy).not.toContain('"packages", "tasq-cli", "dist"');
  });
});
