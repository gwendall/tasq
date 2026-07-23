import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const temporaryPaths: string[] = [];
const productRoot = resolve(import.meta.dir, "../../..");
const builder = join(productRoot, "scripts/release/build-public-release.ts");
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const publishedReleaseDirectory = process.env.TASQ_PUBLISHED_RELEASE_DIR;
const publishedReleaseVersion = (process.env.TASQ_PUBLISHED_RELEASE_VERSION ?? "0.1.0").replace(/^v/, "");
const upgradeReleaseVersion = (() => {
  if (publishedReleaseDirectory === undefined) return "0.2.0";
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(publishedReleaseVersion);
  if (match === null) throw new Error(`published release version must be stable semver: ${publishedReleaseVersion}`);
  return `${match[1]}.${Number(match[2]) + 1}.0`;
})();
const target = process.platform === "darwin" && process.arch === "arm64"
  ? "darwin-arm64"
  : process.platform === "linux" && process.arch === "x64"
    ? "linux-x64-gnu"
    : null;

setDefaultTimeout(180_000);

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function build(version: string, outdir: string, commit = sourceCommit): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    builder,
    "--version",
    version,
    "--source-commit",
    commit,
    "--target",
    target!,
    "--outdir",
    outdir,
  ], { cwd: productRoot, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`release build failed: ${stderr || stdout}`);
}

function releasePaths(directory: string, version: string) {
  const name = `tasq-v${version}-${target}`;
  return {
    archive: join(directory, `${name}.tar.gz`),
    checksums: join(directory, `${name}.SHA256SUMS`),
    installer: join(directory, `${name}.install.ts`),
    manifest: join(directory, `${name}.release.json`),
  };
}

async function run(
  executable: string,
  args: string[],
  options: { cwd?: string; home?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      ...(options.home ? { TASQ_HOME: options.home } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function ok(
  executable: string,
  args: string[],
  options: { cwd?: string; home?: string } = {},
): Promise<string> {
  const result = await run(executable, args, options);
  expect(result, `${basename(executable)} ${args.join(" ")}`).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

async function install(prefix: string, release: ReturnType<typeof releasePaths>): Promise<Record<string, unknown>> {
  const output = await ok(release.installer, [
    "install",
    "--archive",
    release.archive,
    "--manifest",
    release.manifest,
    "--checksums",
    release.checksums,
    "--prefix",
    prefix,
  ], { cwd: tmpdir() });
  return JSON.parse(output);
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<{
  line: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`web process ended before startup: ${text}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return { line: text.slice(0, text.indexOf("\n")), reader };
}

describe.skipIf(target === null)("Tasq clean-room lifecycle", () => {
  test("installs, coordinates, monitors, upgrades, restores, and uninstalls without touching data", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-lifecycle-"));
    temporaryPaths.push(root);
    const releaseV1Directory = join(root, "release-v1");
    const releaseV2Directory = join(root, "release-v2");
    if (publishedReleaseDirectory === undefined) await build("0.1.0", releaseV1Directory);
    await build(upgradeReleaseVersion, releaseV2Directory);
    const releaseV1 = releasePaths(
      publishedReleaseDirectory ?? releaseV1Directory,
      publishedReleaseDirectory === undefined ? "0.1.0" : publishedReleaseVersion,
    );
    const releaseV2 = releasePaths(releaseV2Directory, upgradeReleaseVersion);
    await chmod(releaseV1.installer, 0o755);
    await chmod(releaseV2.installer, 0o755);

    const prefix = join(root, "prefix");
    const home = join(root, "data");
    const cli = join(prefix, "bin", "tasq");
    expect(await install(prefix, releaseV1)).toMatchObject({
      contractVersion: "tasq.lifecycle-result.v1",
      action: "install",
      status: "installed",
      version: publishedReleaseDirectory === undefined ? "0.1.0" : publishedReleaseVersion,
      dataDisposition: "external-not-managed",
    });
    expect((await ok(cli, ["--version"], { cwd: tmpdir(), home })).trim())
      .toBe(publishedReleaseDirectory === undefined ? "0.1.0" : publishedReleaseVersion);

    const onboarding = JSON.parse(await ok(cli, [
      "onboard", "--space", "lifecycle/team", "--actor", "alpha", "--json",
    ], { cwd: tmpdir(), home }));
    expect(onboarding).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      space: { workspaceId: "lifecycle/team" },
      actor: { alias: "alpha" },
    });
    await ok(cli, ["onboard", "--space", "lifecycle/team", "--actor", "beta", "--json"], { home });
    await ok(cli, [
      "add", "Lifecycle survives", "--tenant", "lifecycle/team", "--actor", "alpha", "--json",
    ], { home });

    const scope = ["--tenant", "lifecycle/team", "--json"];
    const [alpha, beta] = await Promise.all([
      run(cli, ["resource", "acquire", "robot:arm", "--actor", "alpha", "--idempotency-key", "alpha-1", ...scope], { home }),
      run(cli, ["resource", "acquire", "robot:arm", "--actor", "beta", "--idempotency-key", "beta-1", ...scope], { home }),
    ]);
    expect([alpha.exitCode, beta.exitCode].sort()).toEqual([0, 1]);
    const winner = JSON.parse(alpha.exitCode === 0 ? alpha.stdout : beta.stdout);
    const loser = JSON.parse(alpha.exitCode === 1 ? alpha.stdout : beta.stdout);
    expect(winner).toMatchObject({ contractVersion: "tasq.resource-operation.v1", disposition: "acquired" });
    expect(loser).toMatchObject({ contractVersion: "tasq.resource-problem.v1", code: "contended", retryable: true });
    await ok(cli, [
      "resource", "release", "robot:arm",
      "--lease", winner.lease.id,
      "--fence", String(winner.lease.fence),
      "--revision", String(winner.lease.revision),
      "--idempotency-key", "winner-release",
      "--actor", winner.lease.holderActor,
      ...scope,
    ], { home });
    const recovered = JSON.parse(await ok(cli, [
      "resource", "acquire", "robot:arm", "--actor", loser.currentLease.lease.holderActor === "alpha" ? "beta" : "alpha",
      "--idempotency-key", "loser-retry", ...scope,
    ], { home }));
    expect(recovered.lease.fence).toBe(2);

    const web = Bun.spawn([
      cli, "web", "--tenant", "lifecycle/team", "--host", "127.0.0.1", "--port", "0", "--json",
    ], { env: { PATH: process.env.PATH ?? "", TASQ_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const webStderr = new Response(web.stderr).text();
    const startup = await firstLine(web.stdout);
    const listener = JSON.parse(startup.line);
    expect(listener).toMatchObject({
      contractVersion: "tasq.console-listener.v1",
      productVersion: publishedReleaseDirectory === undefined ? "0.1.0" : publishedReleaseVersion,
      workspaceId: "lifecycle/team",
      endpoint: { scope: "loopback" },
      process: { mode: "foreground", pid: web.pid },
    });
    const url = listener.endpoint.url as string;
    const discovery = JSON.parse(await ok(cli, ["web", "status", "--tenant", "lifecycle/team", "--json"], { home }));
    expect(discovery).toMatchObject({ state: "running", descriptor: { instanceId: listener.instanceId } });
    const index = await fetch(`${url}/api/index`).then((response) => response.json());
    expect(index).toMatchObject({ contractVersion: "tasq.inspector-index.v1", workspaceId: "lifecycle/team" });
    const v1Console = await fetch(url).then((response) => response.text());
    expect(v1Console).toContain("Lifecycle survives");
    expect(v1Console).toContain(
      `Tasq Local ${publishedReleaseDirectory === undefined ? "0.1.0" : publishedReleaseVersion}`,
    );
    expect(await fetch(`${url}/assets/console.js`).then((response) => response.status)).toBe(200);
    expect(await fetch(`${url}/api/console/runtime`).then((response) => response.json())).toEqual(listener);
    web.kill("SIGTERM");
    expect(await web.exited).toBe(0);
    await startup.reader.cancel();
    expect(await webStderr).toBe("");
    expect(await run(cli, ["web", "status", "--tenant", "lifecycle/team", "--json"], { home }))
      .toMatchObject({ exitCode: 1, stderr: "" });

    const snapshot = join(root, "v1.sqlite");
    await ok(cli, ["backup", snapshot, "--tenant", "lifecycle/team", "--actor", "alpha", "--json"], { home });
    const journalAtSnapshot = await readFile(join(home, "events.jsonl"));
    expect(await install(prefix, releaseV2)).toMatchObject({ status: "installed", version: upgradeReleaseVersion });
    expect((await ok(cli, ["--version"], { home })).trim()).toBe(upgradeReleaseVersion);
    expect(JSON.parse(await ok(cli, [
      "doctor", "--tenant", "lifecycle/team", "--actor", "alpha", "--json",
    ], { home }))).toMatchObject({ ok: true });
    const upgradedTasks = JSON.parse(await ok(cli, ["list", "--tenant", "lifecycle/team", "--actor", "alpha", "--json"], { home }));
    expect(upgradedTasks.map((task: { title: string }) => task.title)).toContain("Lifecycle survives");

    const upgradedWeb = Bun.spawn([
      cli, "web", "--tenant", "lifecycle/team", "--host", "127.0.0.1", "--port", "0", "--json",
    ], { env: { PATH: process.env.PATH ?? "", TASQ_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const upgradedWebStderr = new Response(upgradedWeb.stderr).text();
    const upgradedStartup = await firstLine(upgradedWeb.stdout);
    const upgradedListener = JSON.parse(upgradedStartup.line);
    expect(upgradedListener).toMatchObject({ productVersion: upgradeReleaseVersion, workspaceId: "lifecycle/team" });
    const v2Console = await fetch(upgradedListener.endpoint.url).then((response) => response.text());
    expect(v2Console).toContain("Lifecycle survives");
    expect(v2Console).toContain(`Tasq Local ${upgradeReleaseVersion}`);
    upgradedWeb.kill("SIGTERM");
    expect(await upgradedWeb.exited).toBe(0);
    await upgradedStartup.reader.cancel();
    expect(await upgradedWebStderr).toBe("");

    const restoredHome = join(root, "restored-data");
    await mkdir(restoredHome, { recursive: true, mode: 0o700 });
    await copyFile(snapshot, join(restoredHome, "db.sqlite"));
    await chmod(join(restoredHome, "db.sqlite"), 0o600);
    await writeFile(join(restoredHome, "events.jsonl"), journalAtSnapshot, { mode: 0o600 });
    await ok(releaseV1.installer, [
      "activate", "--version",
      publishedReleaseDirectory === undefined ? "0.1.0" : publishedReleaseVersion,
      "--target", target!, "--prefix", prefix,
    ]);
    expect(JSON.parse(await ok(cli, [
      "doctor", "--tenant", "lifecycle/team", "--actor", "alpha", "--json",
    ], { home: restoredHome }))).toMatchObject({ ok: true });
    const restoredTasks = JSON.parse(await ok(cli, [
      "list", "--tenant", "lifecycle/team", "--actor", "alpha", "--json",
    ], { home: restoredHome }));
    expect(restoredTasks.map((task: { title: string }) => task.title)).toContain("Lifecycle survives");

    const mainDbSize = (await stat(join(home, "db.sqlite"))).size;
    const restoredDbSize = (await stat(join(restoredHome, "db.sqlite"))).size;
    const removedV1 = JSON.parse(await ok(releaseV1.installer, [
      "uninstall", "--version",
      publishedReleaseDirectory === undefined ? "0.1.0" : publishedReleaseVersion,
      "--target", target!, "--prefix", prefix,
    ]));
    expect(removedV1).toMatchObject({ status: "uninstalled", activeLinkRemoved: true, dataDisposition: "preserved-not-touched" });
    await ok(releaseV2.installer, [
      "activate", "--version", upgradeReleaseVersion, "--target", target!, "--prefix", prefix,
    ]);
    const removedV2 = JSON.parse(await ok(releaseV2.installer, [
      "uninstall", "--version", upgradeReleaseVersion, "--target", target!, "--prefix", prefix,
    ]));
    expect(removedV2).toMatchObject({ status: "uninstalled", activeLinkRemoved: true, dataDisposition: "preserved-not-touched" });
    expect((await stat(join(home, "db.sqlite"))).size).toBe(mainDbSize);
    expect((await stat(join(restoredHome, "db.sqlite"))).size).toBe(restoredDbSize);
  });

  test("fails closed on tampering and unmanaged binary collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-lifecycle-safety-"));
    temporaryPaths.push(root);
    const releaseDirectory = join(root, "release");
    await build("0.1.0", releaseDirectory);
    const release = releasePaths(releaseDirectory, "0.1.0");
    await chmod(release.installer, 0o755);

    const tamperedArchive = join(root, basename(release.archive));
    await copyFile(release.archive, tamperedArchive);
    await writeFile(tamperedArchive, Buffer.concat([await readFile(tamperedArchive), Buffer.from("tampered") ]));
    const tampered = await run(release.installer, [
      "install", "--archive", tamperedArchive, "--manifest", release.manifest,
      "--checksums", release.checksums, "--prefix", join(root, "tampered-prefix"),
    ]);
    expect(tampered.exitCode).toBe(1);
    expect(JSON.parse(tampered.stderr)).toMatchObject({ contractVersion: "tasq.lifecycle-error.v1", ok: false });
    expect(tampered.stderr).toContain("archive checksum mismatch");

    const prefix = join(root, "collision-prefix");
    await mkdir(join(prefix, "bin"), { recursive: true });
    await writeFile(join(prefix, "bin", "tasq"), "unmanaged\n");
    const collision = await run(release.installer, [
      "install", "--archive", release.archive, "--manifest", release.manifest,
      "--checksums", release.checksums, "--prefix", prefix,
    ]);
    expect(collision.exitCode).toBe(1);
    expect(collision.stderr).toContain("refusing to replace unmanaged path");
    expect(await readFile(join(prefix, "bin", "tasq"), "utf8")).toBe("unmanaged\n");

    const alteredInstaller = join(root, "altered", basename(release.installer));
    await mkdir(join(root, "altered"), { recursive: true });
    await writeFile(alteredInstaller, Buffer.concat([
      await readFile(release.installer),
      Buffer.from("\n// altered\n"),
    ]));
    await chmod(alteredInstaller, 0o755);
    const selfTamper = await run(alteredInstaller, [
      "install", "--archive", release.archive, "--manifest", release.manifest,
      "--checksums", release.checksums, "--prefix", join(root, "self-tamper-prefix"),
    ]);
    expect(selfTamper.exitCode).toBe(1);
    expect(selfTamper.stderr).toContain("installer checksum mismatch");

    const cleanPrefix = join(root, "clean-prefix");
    expect(await install(cleanPrefix, release)).toMatchObject({ status: "installed" });
    const otherReleaseDirectory = join(root, "other-release");
    await build("0.1.0", otherReleaseDirectory, "fedcba9876543210fedcba9876543210fedcba98");
    const otherRelease = releasePaths(otherReleaseDirectory, "0.1.0");
    await chmod(otherRelease.installer, 0o755);
    const differentBytes = await run(otherRelease.installer, [
      "install", "--archive", otherRelease.archive, "--manifest", otherRelease.manifest,
      "--checksums", otherRelease.checksums, "--prefix", cleanPrefix,
    ]);
    expect(differentBytes.exitCode).toBe(1);
    expect(differentBytes.stderr).toContain("already installed from different bytes");

    const wrongTarget = target === "darwin-arm64" ? "linux-x64-gnu" : "darwin-arm64";
    const wrongHost = await run(release.installer, [
      "activate", "--version", "0.1.0", "--target", wrongTarget, "--prefix", cleanPrefix,
    ]);
    expect(wrongHost.exitCode).toBe(1);
    expect(wrongHost.stderr).toContain("does not match host");
  });
});
