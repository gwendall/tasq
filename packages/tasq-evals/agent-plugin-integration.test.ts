import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const skillPath = "plugins/tasq/skills/tasq/SKILL.md";

describe("zero-context agent integration candidate", () => {
  test("keeps both native adapters on one versioned semantic core", () => {
    const contract = readJson("docs/integrations/AGENT_INTEGRATIONS.json");
    const codexMarketplace = readJson(".agents/plugins/marketplace.json");
    const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
    const codexPlugin = readJson("plugins/tasq/.codex-plugin/plugin.json");
    const claudePlugin = readJson("plugins/tasq/.claude-plugin/plugin.json");
    const openai = readFileSync(resolve(root, "plugins/tasq/skills/tasq/agents/openai.yaml"), "utf8");

    expect(contract).toMatchObject({
      contractVersion: "tasq.agent-integrations.v1",
      integrationVersion: "0.1.1",
      rendezvous: {
        required: ["space", "actor", "capabilities"],
        spaceInference: "forbidden",
        actorInference: "forbidden",
      },
      mcp: {
        staticRegistrationShipped: false,
        discoveryTool: "tasq_discover",
      },
    });
    expect(contract.hosts.map(({ id }: { id: string }) => id)).toEqual(["codex", "claude-code"]);
    expect(codexMarketplace.plugins[0]).toMatchObject({
      name: "tasq",
      source: { source: "local", path: "./plugins/tasq" },
    });
    expect(claudeMarketplace.plugins[0]).toMatchObject({
      name: "tasq",
      source: "./plugins/tasq",
      version: contract.integrationVersion,
    });
    for (const plugin of [codexPlugin, claudePlugin]) {
      expect(plugin).toMatchObject({
        name: "tasq",
        version: contract.integrationVersion,
        skills: "./skills/",
        license: "Apache-2.0",
      });
    }
    expect(openai).toContain("Use $tasq");
    expect(existsSync(resolve(root, "plugins/tasq/.mcp.json"))).toBe(false);
    expect(existsSync(resolve(root, ".mcp.json"))).toBe(false);
  });

  test("teaches a blind agent safe acquisition and durable-only coordination", () => {
    const skill = readFileSync(resolve(root, skillPath), "utf8");
    const required = [
      "private reasoning, temporary checklists",
      "Never infer a space",
      "unrelated unscoped npm package",
      "https://tasq.run/adopt.json",
      "tasq_discover",
      "tasq onboard --space <explicit-space> --actor <stable-label>",
      "--capabilities read,propose,coordinate --json",
      "A successful attempt does not",
      "never prepend `node`, `bun`",
      "Do not read the device clock",
      "explicit human confirmation",
      "untrusted data",
      "Do not write SQL",
    ];
    for (const text of required) expect(skill, `missing safety contract: ${text}`).toContain(text);
    expect(skill).not.toMatch(/TODO|FIXME|Local developer|example-plugin/);
    expect(skill).not.toContain("npm install tasq");
  });

  test("publishes exact native install and symmetric uninstall argv", () => {
    const contract = readJson("docs/integrations/AGENT_INTEGRATIONS.json");
    const byId = new Map(contract.hosts.map((host: { id: string }) => [host.id, host]));
    expect(byId.get("codex")).toMatchObject({
      install: [
        ["codex", "plugin", "marketplace", "add", "gwendall/tasq", "--ref", "main"],
        ["codex", "plugin", "add", "tasq@tasq"],
      ],
      uninstall: [
        ["codex", "plugin", "remove", "tasq@tasq"],
        ["codex", "plugin", "marketplace", "remove", "tasq"],
      ],
    });
    expect(byId.get("claude-code")).toMatchObject({
      install: [
        ["claude", "plugin", "marketplace", "add", "gwendall/tasq", "--scope", "user"],
        ["claude", "plugin", "install", "tasq@tasq", "--scope", "user"],
      ],
      uninstall: [
        ["claude", "plugin", "uninstall", "tasq@tasq", "--scope", "user"],
        ["claude", "plugin", "marketplace", "remove", "tasq", "--scope", "user"],
      ],
    });
    expect(contract.ownership.uninstallPreserves).toEqual(["TASQ_HOME", "ledger", "database", "backups"]);
  });

  test("records immutable native lifecycle and blind behavioral evidence", () => {
    const certificate = readJson("docs/contracts/TQ-321_AGENT_PLUGIN_CERTIFICATION.json");
    expect(certificate).toMatchObject({
      contractVersion: "tasq.agent-plugin-certification.v1",
      integrationVersion: "0.1.1",
      status: "passed-public-native-lifecycle-and-blind-behavior",
      isolation: {
        cleanTemporaryHomes: true,
        remoteCloneViaHttps: true,
        userConfigurationTouched: false,
        tasqHomeTouched: false,
        ledgerTouched: false,
      },
      behavioralAcceptance: {
        codex: "passed",
        claudeCode: "passed",
        processRestart: "passed",
        exclusiveCursorResume: "passed",
        resourceContentionAndStaleFenceRejection: "passed",
        evidenceBackedExplicitCompletion: "passed",
        nativeUninstallPreservedLedgerByteForByte: "passed",
      },
      tq321Complete: true,
    });
    expect(certificate.hosts).toEqual([
      expect.objectContaining({ id: "codex", install: "passed", uninstall: "passed" }),
      expect.objectContaining({ id: "claude-code", install: "passed", uninstall: "passed" }),
    ]);
    expect(certificate.remaining).toEqual([]);
    const behavioral = readJson(certificate.sharedSkill.behavioralCertificate);
    expect(behavioral).toMatchObject({
      contractVersion: "tasq.zero-context-agent-certification.v1",
      acceptance: {
        passed: true,
        requiredHosts: ["codex", "claude-code"],
        completedHosts: ["codex", "claude-code"],
      },
    });
    expect(behavioral.trials).toHaveLength(2);
    expect(behavioral.trials.every((trial: { pass: boolean }) => trial.pass)).toBe(true);
    const publicComponents = behavioral.releaseArtifact.bundledComponents.filter(
      (component: { name: string }) => component.name.startsWith("@tasq"),
    );
    expect(publicComponents.length).toBeGreaterThan(0);
    expect(publicComponents.every((component: { name: string; purl: string }) => (
      component.name.startsWith("@tasq-run/")
      && component.purl.startsWith(`pkg:npm/%40${component.name.slice(1)}@`)
    ))).toBe(true);
    expect(certificate.source.ref).toMatch(/^[0-9a-f]{40}$/);
    for (const [path, digest] of Object.entries(certificate.source.sha256 as Record<string, string>)) {
      expect(path.length).toBeGreaterThan(0);
      expect(digest, `${path}: invalid historical digest`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
