import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const workflowsRoot = resolve(root, ".github/workflows");
const workflows = Object.fromEntries(
  readdirSync(workflowsRoot)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [name, readFileSync(resolve(workflowsRoot, name), "utf8")]),
);

function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `missing workflow job ${name}`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function runBodies(workflow: string): string[] {
  const lines = workflow.split("\n");
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index]!);
    if (!match) continue;
    const indentation = match[1]!.length;
    const body = [match[2]!];
    while (index + 1 < lines.length) {
      const next = lines[index + 1]!;
      if (next.trim() !== "" && next.length - next.trimStart().length <= indentation) break;
      body.push(next);
      index += 1;
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

describe("GitHub workflow supply-chain policy", () => {
  test("pins every external action to an immutable commit with readable version context", () => {
    for (const [name, workflow] of Object.entries(workflows)) {
      const actions = [...workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)\s+#\s+(v[^\s]+)/g)];
      expect(actions.length, `${name}: no external actions found`).toBeGreaterThan(0);
      for (const [, action, revision, version] of actions) {
        expect(revision, `${name}: ${action} is not commit-pinned`).toMatch(/^[a-f0-9]{40}$/);
        expect(version, `${name}: ${action} lacks version context`).toMatch(/^v\d/);
      }
      expect(
        [...workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)].length,
        `${name}: an action lacks a readable version comment`,
      ).toBe(actions.length);
      const checkoutCount = actions.filter(([, action]) => action === "actions/checkout").length;
      expect(
        [...workflow.matchAll(/persist-credentials:\s+false/g)].length,
        `${name}: every checkout must discard its token after fetching`,
      ).toBe(checkoutCount);
    }
  });

  test("denies workflow-level token access and scopes sensitive jobs explicitly", () => {
    for (const [name, workflow] of Object.entries(workflows)) {
      expect(workflow, `${name}: workflow permissions must default to none`)
        .toMatch(/\npermissions: \{\}\n/);
    }

    expect(job(workflows["bootstrap-npm.yml"]!, "bootstrap")).toContain(
      "permissions:\n      contents: read\n      id-token: write\n      attestations: write",
    );
    expect(job(workflows["bootstrap-npm-client.yml"]!, "bootstrap-client")).toContain(
      "permissions:\n      contents: read\n      id-token: write\n      attestations: write",
    );
    expect(job(workflows["certify-published-release.yml"]!, "published-bytes")).toContain(
      "permissions:\n      contents: read\n      attestations: read",
    );
    expect(job(workflows["certify-published-release.yml"]!, "npm-registry")).toContain(
      "permissions:\n      contents: read",
    );

    const release = workflows["release.yml"]!;
    expect(job(release, "identity")).toContain("permissions:\n      contents: read");
    for (const name of ["cli", "npm"]) {
      expect(job(release, name)).toContain(
        "permissions:\n      contents: read\n      id-token: write\n      attestations: write",
      );
    }
    expect(job(release, "github-release")).toContain("permissions:\n      contents: write");
    expect(job(release, "github-release")).not.toContain("id-token: write");
    expect(job(release, "github-release")).not.toContain("attestations: write");

    const publishServer = workflows["publish-server.yml"]!;
    expect(job(publishServer, "authorize")).toContain("permissions:\n      contents: read");
    expect(job(publishServer, "publish-image")).toContain(
      "permissions:\n      contents: read\n      packages: write\n      id-token: write\n      attestations: write",
    );
    expect(job(publishServer, "publish-release-metadata")).toContain(
      "permissions:\n      contents: write",
    );

    const publishPython = workflows["publish-python.yml"]!;
    expect(job(publishPython, "publish-pypi")).toContain(
      "permissions:\n      contents: read\n      id-token: write\n      attestations: read",
    );
    expect(job(publishPython, "publish-pypi")).not.toContain("contents: write");
    expect(job(workflows["certify-published-server.yml"]!, "exact-image")).toContain(
      "permissions:\n      contents: read\n      packages: read\n      attestations: read",
    );
    expect(job(workflows["certify-published-python.yml"]!, "exact-wheel")).toContain(
      "permissions:\n      contents: read\n      packages: read\n      attestations: read",
    );
  });

  test("scans complete history with an exact, checksum-verified and redacting Gitleaks binary", () => {
    const scan = job(workflows["ci.yml"]!, "secret-scan");
    expect(scan).toContain("fetch-depth: 0");
    expect(scan).toContain("GITLEAKS_VERSION: 8.28.0");
    expect(scan).toContain(
      "GITLEAKS_ARCHIVE_SHA256: a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb",
    );
    expect(scan).toContain("sha256sum --check --status");
    expect(scan).toContain("git --redact --no-banner --log-opts=--all .");
    expect(scan).not.toContain("--verbose");
    expect(scan).not.toContain("upload-artifact");
  });

  test("never interpolates dispatch inputs into generated shell source", () => {
    for (const [name, workflow] of Object.entries(workflows)) {
      for (const body of runBodies(workflow)) {
        expect(body, `${name}: dispatch input interpolation in run block`)
          .not.toContain("${{ inputs.");
      }
    }
  });
});
