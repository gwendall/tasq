import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

function run(argv: string[]) {
  const child = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

describe("coding-agent onboarding and handoff", () => {
  test("preflight identifies the canonical checkout and current executable work", () => {
    const result = run([process.execPath, "scripts/agent-preflight.ts", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const preflight = JSON.parse(result.stdout);
    const dogfood = JSON.parse(readFileSync(resolve(root, "TQ-607_DOGFOOD_STATUS.json"), "utf8"));
    expect(preflight).toMatchObject({
      contractVersion: "tasq.agent-preflight.v1",
      ok: true,
      repository: {
        canonical: true,
      },
      work: {
        activeBacklogItem: { id: "TQ-607", status: "in_progress_dogfood" },
        dogfood: {
          phase: dogfood.currentPhase,
          nextAction: dogfood.nextAction,
          earliestDecisionAt: dogfood.earliestDecisionAt,
        },
      },
      readFirst: ["AGENTS.md", "DEVELOPMENT.md", "CURRENT_STATE.md", "BACKLOG.json"],
      verification: { handoff: [["pnpm", "verify:handoff"]] },
    });
    expect(preflight.repository.origin).toMatch(/^https:\/\/github\.com\/gwendall\/tasq(?:\.git)?$/);
    expect(preflight.work.dogfood.nextAction).toBeTruthy();
  });

  test("installed-style CLI help has a self-contained machine onboarding pointer", () => {
    const result = run([process.execPath, "packages/tasq-cli/src/index.ts", "--help"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Agent start: tasq onboard --space <id> --actor <label> --json");
    expect(result.stdout).not.toContain("SKILL.md");
    expect(result.stdout).not.toContain("CURRENT_STATE.md");
    expect(result.stdout).not.toContain("BACKLOG.md");
  });

  test("root scripts and handoff template expose one complete path", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.scripts).toMatchObject({
      "agent:preflight": "bun scripts/agent-preflight.ts",
      "verify:handoff": "bun scripts/verify-handoff.ts",
      "verify:quick": "bun scripts/verify-handoff.ts --quick",
    });
    const template = readFileSync(resolve(root, ".github/pull_request_template.md"), "utf8");
    expect(template).toContain("pnpm docs:check");
    expect(template).toContain("pnpm typecheck");
    expect(template).toContain("pnpm test");
  });
});
