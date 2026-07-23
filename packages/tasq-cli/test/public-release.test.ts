import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryPaths: string[] = [];
const productRoot = resolve(import.meta.dir, "../../..");
const script = join(productRoot, "scripts/release/build-public-release.ts");
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const target = process.platform === "darwin" && process.arch === "arm64"
  ? "darwin-arm64"
  : process.platform === "linux" && process.arch === "x64"
    ? "linux-x64-gnu"
    : null;

setDefaultTimeout(120_000);

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function build(outdir: string, requestedTarget = target): Promise<{ exitCode: number; stderr: string }> {
  if (!requestedTarget) throw new Error("Unsupported test host");
  const child = Bun.spawn([
    process.execPath,
    script,
    "--version",
    "0.1.0",
    "--source-commit",
    sourceCommit,
    "--target",
    requestedTarget,
    "--outdir",
    outdir,
  ], { cwd: productRoot, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(path));
  return hasher.digest("hex");
}

describe.skipIf(target === null)("Tasq public release envelope", () => {
  test("is byte-reproducible, complete, and boots outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-public-release-"));
    temporaryPaths.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    expect(await build(first)).toEqual({ exitCode: 0, stderr: "" });
    expect(await build(second)).toEqual({ exitCode: 0, stderr: "" });

    const expectedPrefix = `tasq-v0.1.0-${target}`;
    const names = (await readdir(first)).sort();
    expect(names).toEqual([
      `${expectedPrefix}.SHA256SUMS`,
      `${expectedPrefix}.cdx.json`,
      `${expectedPrefix}.install.ts`,
      `${expectedPrefix}.release.json`,
      `${expectedPrefix}.tar.gz`,
    ]);
    for (const name of names) expect(await digest(join(first, name)), name).toBe(await digest(join(second, name)));

    const release = JSON.parse(await readFile(join(first, `${expectedPrefix}.release.json`), "utf8"));
    expect(release).toMatchObject({
      contractVersion: "tasq.public-release.v1",
      version: "0.1.0",
      source: { commit: sourceCommit },
      target,
      compatibility: {
        directUpgradeFromMinorLines: 2,
        storeFormat: {
          contractVersion: "tasq.store-format.v1",
          current: 25,
          readable: { min: 25, max: 25 },
          writable: { min: 25, max: 25 },
          directlyMigratable: { min: 0, max: 25 },
        },
        oldestDirectlyTestedSourceRelease: null,
      },
      provenance: { localArtifactsPublishable: false },
    });
    expect(JSON.stringify(release)).not.toMatch(/generatedAt|createdAt|timestamp/);

    const sbom = JSON.parse(await readFile(join(first, `${expectedPrefix}.cdx.json`), "utf8"));
    expect(sbom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6" });
    expect(sbom.metadata.component.purl).toBe("pkg:npm/%40tasq-run/cli@0.1.0");
    expect(sbom.components.length).toBeGreaterThan(5);
    expect(sbom.components.some((component: { name: string }) => component.name === "@libsql/client")).toBe(true);
    expect(JSON.stringify(sbom)).not.toContain("@kami/");
    expect(sbom.components.every((component: { licenses: Array<{ license: { id: string } }> }) => (
      component.licenses[0]?.license.id !== "NOASSERTION"
    ))).toBe(true);

    const checksums = await readFile(join(first, `${expectedPrefix}.SHA256SUMS`), "utf8");
    for (const name of names.filter((name) => !name.endsWith("SHA256SUMS"))) {
      expect(checksums).toContain(`${await digest(join(first, name))}  ${name}`);
    }

    const extracted = join(root, "extracted");
    await Bun.$`mkdir -p ${extracted}`;
    await Bun.$`tar -xzf ${join(first, `${expectedPrefix}.tar.gz`)} -C ${extracted}`;
    const payload = join(extracted, expectedPrefix);
    const cli = join(payload, "index.js");
    await chmod(cli, 0o755);
    const home = join(root, "home");
    const onboarding = Bun.spawn([
      cli,
      "onboard",
      "--space",
      "public-release-smoke",
      "--actor",
      "clean-room-agent",
      "--json",
    ], {
      cwd: extracted,
      env: { PATH: process.env.PATH ?? "", TASQ_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      onboarding.exited,
      new Response(onboarding.stdout).text(),
      new Response(onboarding.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      space: { workspaceId: "public-release-smoke" },
      actor: { alias: "clean-room-agent" },
    });
    expect(await readFile(join(payload, "LICENSE"), "utf8")).toContain("Apache License");
    expect(await readFile(join(payload, "THIRD_PARTY_NOTICES.txt"), "utf8")).toContain("@libsql/client");
    expect(JSON.parse(await readFile(join(payload, "SBOM.cdx.json"), "utf8"))).toEqual(sbom);
    for (const name of await readdir(payload)) {
      const path = join(payload, name);
      if (name === "node_modules") continue;
      expect((await readFile(path)).toString(), name).not.toContain(productRoot);
    }
  });

  test("fails closed on target mismatch and invalid release identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-public-release-invalid-"));
    temporaryPaths.push(root);
    const wrongTarget = target === "darwin-arm64" ? "linux-x64-gnu" : "darwin-arm64";
    const mismatch = await build(join(root, "mismatch"), wrongTarget);
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr).toContain(`requested ${wrongTarget}`);

    const invalid = Bun.spawn([
      process.execPath,
      script,
      "--version",
      "latest",
      "--source-commit",
      sourceCommit,
      "--target",
      target!,
      "--outdir",
      join(root, "invalid"),
    ], { cwd: productRoot, stdout: "pipe", stderr: "pipe" });
    expect(await invalid.exited).not.toBe(0);
    expect(await new Response(invalid.stderr).text()).toContain("SemVer");
  });

  test("detects checksum tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-public-release-tamper-"));
    temporaryPaths.push(root);
    expect((await build(root)).exitCode).toBe(0);
    const prefix = `tasq-v0.1.0-${target}`;
    const archive = join(root, `${prefix}.tar.gz`);
    const before = await digest(archive);
    await writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from("tampered") ]));
    expect(await digest(archive)).not.toBe(before);
    const checksums = await readFile(join(root, `${prefix}.SHA256SUMS`), "utf8");
    expect(checksums).toContain(before);
    expect(checksums).not.toContain(await digest(archive));
  });
});
