import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const deployment = join(import.meta.dir, "../../../deploy/gcp-compute-experimental");

async function deploymentFile(path: string): Promise<string> {
  return readFile(join(deployment, path), "utf8");
}

describe("experimental GCP Compute Engine deployment", () => {
  test("keeps one protected Paris mono-writer and immutable runtime authorities", async () => {
    const [main, variables, outputs] = await Promise.all([
      deploymentFile("main.tf"),
      deploymentFile("variables.tf"),
      deploymentFile("outputs.tf"),
    ]);

    expect(variables).toContain('default     = "europe-west9"');
    expect(variables).toContain('default     = "europe-west9-a"');
    expect(variables).toContain('default     = "e2-small"');
    expect(variables).toContain(
      "^ghcr\\\\.io/gwendall/tasq-server@sha256:[0-9a-f]{64}$",
    );
    expect(variables).toContain("must use an exact sha256 digest");
    expect(variables).toContain("must be one explicit numeric version, never latest");
    expect(main).toContain('type = "pd-balanced"');
    expect(main).toMatch(/deletion_protection\s*=\s*var\.deletion_protection/);
    expect(main.match(/prevent_destroy = true/g)).toHaveLength(2);
    expect(main).toMatch(/tasq-experimental-effects\s*=\s*"false"/);
    expect(outputs).toContain("server_image_authority");
    expect(outputs).toContain("resolved_cos_image");
    expect(main).not.toContain("secret_data");
    expect(main).not.toContain("credentials");
  });

  test("exposes only HTTPS publicly and keeps administration on IAP", async () => {
    const main = await deploymentFile("main.tf");
    expect(main).toContain('source_ranges = ["0.0.0.0/0"]');
    expect(main).toContain('ports    = ["80", "443"]');
    expect(main).toContain('source_ranges = ["35.235.240.0/20"]');
    expect(main).toContain('ports    = ["22"]');
    expect(main).not.toMatch(/ports\s*=\s*\[[^\]]*"8787"/);
    expect(main).toMatch(/block-project-ssh-keys\s*=\s*"TRUE"/);
    expect(main).toMatch(/enable-oslogin\s*=\s*"TRUE"/);
  });

  test("protects regional backups and grants the VM only object and exact-secret access", async () => {
    const main = await deploymentFile("main.tf");
    expect(main).toContain("uniform_bucket_level_access = true");
    expect(main).toContain('public_access_prevention    = "enforced"');
    expect(main).toContain("force_destroy               = false");
    expect(main.match(/retention_duration_seconds = 3024000/g)).toHaveLength(1);
    expect(main).toContain("retention_period = 3024000");
    expect(main).toContain('role   = "roles/storage.objectCreator"');
    expect(main).toContain('role   = "roles/storage.objectViewer"');
    expect(main.match(/roles\/secretmanager\.secretAccessor/g)).toHaveLength(3);
    expect(main).not.toContain("roles/storage.admin");
    expect(main).not.toContain("roles/secretmanager.admin");
  });

  test("initializes bind ownership from exact images and runs normal containers constrained", async () => {
    const [init, start] = await Promise.all([
      deploymentFile("scripts/init-data.sh"),
      deploymentFile("scripts/start-containers.sh"),
    ]);

    expect(init).toContain("--user root");
    expect(init).toContain('owner="$(id -u tasq):$(id -g tasq)"');
    expect(init).toContain('readonly CADDY_RUNTIME_ID="65532:65532"');
    expect(init.match(/--network none/g)).toHaveLength(2);
    expect(init.match(/--read-only/g)).toHaveLength(2);
    expect(init.match(/--cap-drop ALL/g)).toHaveLength(2);
    expect(init.match(/--cap-add CHOWN/g)).toHaveLength(2);
    expect(start).toContain('"${RUNTIME_ROOT}/init-data.sh"');
    expect(start).toContain("--read-only");
    expect(start).toContain("--cap-drop ALL");
    expect(start).toContain("--security-opt no-new-privileges:true");
    expect(start.match(/--user tasq/g)).toHaveLength(3);
    expect(start).toContain("--user 65532:65532");
    expect(start).toContain('bun -e \'process.exit((await fetch("http://127.0.0.1:8787/readyz")).ok ? 0 : 1)\'');
    expect(start).not.toContain("wget");
    expect(start).not.toContain("--publish 8787");
    expect(start).toContain("--publish 80:80");
    expect(start).toContain("--publish 443:443");
  });

  test("backs up and restores only explicit complete application snapshots", async () => {
    const [backup, restore] = await Promise.all([
      deploymentFile("scripts/backup.sh"),
      deploymentFile("scripts/restore.sh"),
    ]);

    expect(backup).toContain('BACKUP_ID="${1:-}"');
    expect(backup).not.toMatch(/\bdate\b/);
    expect(backup).toContain('"${BACKUP_PATH}/manifest.json"');
    expect(backup).toContain('"${BACKUP_PATH}/.complete"');
    expect(backup).toContain('"${BACKUP_PATH}/.incomplete"');
    expect(backup).toContain('"gs://${BACKUP_BUCKET}/"');

    expect(restore).toContain('readonly REQUIRED_CONFIRMATION="RESTORE_EXPERIMENTAL_TASQ"');
    expect(restore).toContain("trap rollback_failed_restore ERR");
    expect(restore).toContain('mv "${DATA_ROOT}/live" "${RETIRED_PATH}"');
    expect(restore).toContain('"${RUNTIME_ROOT}/init-data.sh"');
    expect(restore).toContain("previous live bytes retained");

    for (const script of [backup, restore]) {
      expect(script).not.toContain("rm -rf");
      expect(script).not.toContain("curl |");
      expect(script).not.toMatch(/\beval\b/);
    }
  });

  test("documents the experimental claim and refuses to imply an applied managed service", async () => {
    const readme = await deploymentFile("README.md");
    expect(readme).toContain("experimental self-hosting infrastructure");
    expect(readme).toMatch(/not the\s+TQ-901–TQ-905 managed Cloud/);
    expect(readme).toContain("not highly available");
    expect(readme).toContain("Effects remain disabled");
    expect(readme).toContain("No resources were created");
    expect(readme).toContain("no active identity");
    expect(readme).toMatch(/explicit enabled numeric\s+versions/);
    expect(readme).toContain("RESTORE_EXPERIMENTAL_TASQ");
  });
});
