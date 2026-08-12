import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const version = "0.4.0";
const commit = "c".repeat(40);
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
let scratch = "";
let fakeBin = "";

async function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tasq-publication-resume-"));
  fakeBin = join(scratch, "bin");
  await mkdir(fakeBin);
  const docker = join(fakeBin, "docker");
  await writeFile(docker, `#!/usr/bin/env bash
set -euo pipefail
mode="\${FAKE_OCI_MODE:?}"
last="\${!#}"
if test "\${1:-}" = "buildx" && test "\${2:-}" = "imagetools" && test "\${3:-}" = "inspect"; then
  case "$mode" in
    absent)
      echo "MANIFEST_UNKNOWN: manifest unknown" >&2
      exit 1
      ;;
    buildx-not-found)
      echo "ERROR: $last: not found" >&2
      exit 1
      ;;
    buildx-not-found-crlf)
      printf 'ERROR: %s: not found\r\n' "$last" >&2
      exit 1
      ;;
    matching)
      echo "Digest: ${digestA}"
      ;;
    source-only)
      if [[ "$last" == *":sha-"* ]]; then
        echo "Digest: ${digestA}"
      else
        echo "manifest unknown" >&2
        exit 1
      fi
      ;;
    mismatch)
      if [[ "$last" == *":sha-"* ]]; then
        echo "Digest: ${digestB}"
      else
        echo "Digest: ${digestA}"
      fi
      ;;
    transport)
      echo "dial tcp: registry unavailable" >&2
      exit 7
      ;;
    ensure-match)
      echo "Digest: ${digestA}"
      ;;
    ensure-mismatch)
      echo "Digest: ${digestB}"
      ;;
    ensure-create)
      if test -f "\${FAKE_OCI_STATE:?}"; then
        echo "Digest: ${digestA}"
      else
        echo "ERROR: $last: not found" >&2
        exit 1
      fi
      ;;
    *)
      exit 70
      ;;
  esac
elif test "\${1:-}" = "buildx" && test "\${2:-}" = "imagetools" && test "\${3:-}" = "create"; then
  test "$mode" = "ensure-create"
  : > "\${FAKE_OCI_STATE:?}"
else
  echo "unexpected docker invocation: $*" >&2
  exit 71
fi
`);
  await chmod(docker, 0o755);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("OCI publication resume", () => {
  const resolver = "scripts/release/resolve-oci-publication-resume.sh";
  const ensure = "scripts/release/ensure-oci-tag.sh";
  const env = (mode: string, extra: Record<string, string> = {}) => ({
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    FAKE_OCI_MODE: mode,
    ...extra,
  });

  test("builds only when both protected tags are explicit manifest misses", async () => {
    const result = await run(
      ["bash", resolver, "ghcr.io/gwendall/tasq-server", version, commit],
      env("absent"),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "build",
      digest: null,
      versionTagExists: false,
      sourceTagExists: false,
    });
  });

  test("accepts buildx not-found only when it names the exact requested tag", async () => {
    for (const mode of ["buildx-not-found", "buildx-not-found-crlf"]) {
      const result = await run(
        ["bash", resolver, "ghcr.io/gwendall/tasq-server", version, commit],
        env(mode),
      );
      expect(result.code, `${mode}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        action: "build",
        digest: null,
        versionTagExists: false,
        sourceTagExists: false,
      });
    }
  });

  test("reuses one exact anchor and detects conflicting anchors", async () => {
    const reusable = await run(
      ["bash", resolver, "ghcr.io/gwendall/tasq-server", version, commit],
      env("source-only"),
    );
    expect(reusable.code, reusable.stderr).toBe(0);
    expect(JSON.parse(reusable.stdout)).toEqual({
      action: "reuse",
      digest: digestA,
      versionTagExists: false,
      sourceTagExists: true,
    });

    const conflict = await run(
      ["bash", resolver, "ghcr.io/gwendall/tasq-server", version, commit],
      env("mismatch"),
    );
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain(
      "Existing version and source tags resolve to different immutable digests",
    );
  });

  test("never treats an ambiguous registry failure as absence", async () => {
    const result = await run(
      ["bash", resolver, "ghcr.io/gwendall/tasq-server", version, commit],
      env("transport"),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Registry lookup failed without an explicit missing-manifest result",
    );
  });

  test("verifies an existing tag and refuses overwrite on digest drift", async () => {
    const reference = "ghcr.io/gwendall/tasq-server:0.4.0";
    const source = `ghcr.io/gwendall/tasq-server@${digestA}`;
    const exact = await run(
      ["bash", ensure, reference, source, digestA],
      env("ensure-match"),
    );
    expect(exact.code, exact.stderr).toBe(0);
    expect(exact.stdout).toContain("verified-existing");

    const drift = await run(
      ["bash", ensure, reference, source, digestA],
      env("ensure-mismatch"),
    );
    expect(drift.code).not.toBe(0);
    expect(drift.stderr).toContain("Refusing to overwrite");
  });

  test("creates only an explicitly absent tag and verifies the result", async () => {
    const state = join(scratch, "created-tag");
    await rm(state, { force: true });
    const result = await run(
      [
        "bash",
        ensure,
        "ghcr.io/gwendall/tasq-server:0.4.0",
        `ghcr.io/gwendall/tasq-server@${digestA}`,
        digestA,
      ],
      env("ensure-create", { FAKE_OCI_STATE: state }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("published-and-verified");
  });
});

describe("PyPI publication resume", () => {
  const candidateName = `tasq_remote-${version}-py3-none-any.whl`;
  const candidateBytes = new TextEncoder().encode("exact-protected-wheel");
  const remoteSha = new Bun.CryptoHasher("sha256").update(candidateBytes).digest("hex");
  let metadataMode: "exact" | "duplicate" | "absent" | "query" = "exact";
  let remoteBytes = candidateBytes;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    const candidate = join(scratch, candidateName);
    await writeFile(candidate, candidateBytes);
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/json")) {
          if (metadataMode === "absent") {
            return new Response("missing", { status: 404 });
          }
          const entry = {
            filename: candidateName,
            packagetype: "bdist_wheel",
            yanked: false,
            size: remoteBytes.byteLength,
            digests: { sha256: remoteSha },
            url: metadataMode === "query"
              ? `${server.url}files/${candidateName}?credential=secret`
              : `${server.url}files/${candidateName}`,
          };
          return Response.json({
            info: { name: "tasq-remote", version },
            urls: metadataMode === "duplicate" ? [entry, entry] : [entry],
          });
        }
        if (url.pathname === `/files/${candidateName}`) {
          return new Response(remoteBytes);
        }
        return new Response("missing", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  async function inspect(suffix: string) {
    const downloadDir = join(scratch, `pypi-${suffix}`);
    await rm(downloadDir, { recursive: true, force: true });
    return run([
      "python3",
      "scripts/release/verify_pypi_resume.py",
      "--candidate",
      join(scratch, candidateName),
      "--package",
      "tasq-remote",
      "--version",
      version,
      "--download-dir",
      downloadDir,
      "--index-base-url",
      `${server.url}pypi`,
      "--allow-insecure-loopback-test-index",
    ]);
  }

  test("distinguishes an absent coordinate from exact reusable bytes", async () => {
    metadataMode = "absent";
    const absent = await inspect("absent");
    expect(absent.code, absent.stderr).toBe(0);
    expect(JSON.parse(absent.stdout).state).toBe("absent");

    metadataMode = "exact";
    remoteBytes = candidateBytes;
    const exact = await inspect("exact");
    expect(exact.code, exact.stderr).toBe(0);
    expect(JSON.parse(exact.stdout)).toMatchObject({
      contractVersion: "tasq.pypi-publication-resume.v1",
      state: "identical",
      package: "tasq-remote",
      version,
      filename: candidateName,
      sha256: remoteSha,
    });
  });

  test("fails closed on changed bytes or ambiguous wheel metadata", async () => {
    metadataMode = "exact";
    remoteBytes = new TextEncoder().encode("different-wheel");
    const drift = await inspect("drift");
    expect(drift.code).not.toBe(0);
    expect(drift.stderr).toContain("downloaded wheel differs from PyPI SHA-256");

    metadataMode = "duplicate";
    remoteBytes = candidateBytes;
    const duplicate = await inspect("duplicate");
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.stderr).toContain(
      "PyPI must expose exactly one expected universal wheel",
    );

    metadataMode = "query";
    const credentialUrl = await inspect("credential-url");
    expect(credentialUrl.code).not.toBe(0);
    expect(credentialUrl.stderr).toContain(
      "registry URLs must not contain credentials, query, or fragment",
    );
  });
});
