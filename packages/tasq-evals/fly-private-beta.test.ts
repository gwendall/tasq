import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const fly = readFileSync(resolve(root, "deploy/fly-private-beta/fly.toml"), "utf8");
const workflow = readFileSync(resolve(root, ".github/workflows/deploy-fly-private-beta.yml"), "utf8");
const runbook = readFileSync(resolve(root, "deploy/fly-private-beta/README.md"), "utf8");
const dockerfile = readFileSync(resolve(root, "deploy/server/Dockerfile"), "utf8");
const redirect = JSON.parse(readFileSync(resolve(root, "apps/site/vercel.json"), "utf8")) as {
  redirects: Array<{ source: string; destination: string; permanent: boolean; has: Array<{ type: string; value: string }> }>;
};

describe("Fly private-beta deployment", () => {
  test("keeps exactly one canonical Server origin and one non-root volume owner", () => {
    expect(fly).toContain('app = "tasq-api"');
    expect(fly).toContain('primary_region = "cdg"');
    expect(fly).toContain('strategy = "immediate"');
    expect(fly).toContain('source = "tasq_data"');
    expect(fly).toContain('destination = "/var/lib/tasq"');
    expect(fly).toContain('snapshot_retention = 30');
    expect(fly).toContain('auto_stop_machines = "off"');
    expect(fly).not.toMatch(/^\s*image\s*=/m);
    expect(dockerfile).toContain("addgroup -g 10001 -S tasq");
    expect(dockerfile).toContain("adduser -u 10001 -S -G tasq");
    expect(runbook).toContain("`https://api.tasq.run` | Fly app `tasq-api`");
    expect(runbook).toContain("the only JWT audience");
  });

  test("deploys only an attested immutable image and refuses implicit HA", () => {
    expect(workflow).toContain('[[ "$INPUT_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]');
    expect(workflow).toContain("gh attestation verify");
    expect(workflow).toContain('--signer-workflow "gwendall/tasq/.github/workflows/publish-server.yml"');
    expect(workflow).toContain('--source-ref "refs/heads/main"');
    expect(workflow).toContain('--image "$TASQ_IMAGE@$INPUT_DIGEST"');
    expect(workflow).toContain("--ha=false");
    expect(workflow).toContain("--strategy immediate");
    expect(workflow).toContain("for attempt in $(seq 1 30); do");
    expect(workflow).toContain('--machine "$machine_id"');
    expect(workflow).toContain('test "$console_status" = 401');
    expect(workflow).toContain('test "$machine_count" = 1');
    expect(workflow).not.toContain("flyctl deploy --remote-only");
  });

  test("routes the human hostname by redirect instead of a second-origin proxy", () => {
    expect(redirect.redirects).toEqual([
      {
        source: "/(.*)",
        has: [{ type: "host", value: "cloud.tasq.run" }],
        destination: "https://api.tasq.run/console",
        permanent: false,
      },
    ]);
    expect(runbook).toMatch(/must never proxy the\s+Console under a second browser origin/);
  });
});
