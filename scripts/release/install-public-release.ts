#!/usr/bin/env bun

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Target = "darwin-arm64" | "linux-x64-gnu";
type Command = "install" | "activate" | "uninstall";

interface ReleaseManifest {
  contractVersion: "tasq.public-release.v1";
  product: "Tasq Local";
  version: string;
  source: { repository: string; commit: string };
  target: Target;
  files: Array<{ name: string; mediaType: string; sha256: string }>;
}

interface InstallRecord {
  contractVersion: "tasq.install-record.v1";
  version: string;
  target: Target;
  source: ReleaseManifest["source"];
  archive: { name: string; sha256: string };
  manifest: { name: string; sha256: string };
  executable: string;
  dataDisposition: "external-never-managed";
}

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new Error(message);
}

function flag(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if ((!value || value.startsWith("--")) && required) fail(`${name} is required`);
  return value && !value.startsWith("--") ? value : undefined;
}

function command(): Command {
  const value = process.argv[2];
  if (value === "install" || value === "activate" || value === "uninstall") return value;
  fail("usage: install-public-release.ts <install|activate|uninstall> [options]");
}

function hostTarget(): Target {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  fail(`unsupported host: ${process.platform}-${process.arch}`);
}

function requestedIdentity(): { version: string; target: Target } {
  const version = flag("--version")!;
  if (!SEMVER.test(version)) fail(`--version must be SemVer: ${version}`);
  const target = flag("--target")!;
  if (target !== "darwin-arm64" && target !== "linux-x64-gnu") fail(`unsupported target: ${target}`);
  if (target !== hostTarget()) fail(`release target ${target} does not match host ${hostTarget()}`);
  return { version, target };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function ensureManagedDirectory(path: string): Promise<void> {
  if (await exists(path)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`managed path must be a real directory: ${path}`);
    return;
  }
  await mkdir(path, { recursive: false, mode: 0o755 });
}

async function managedLayout(prefixInput: string): Promise<{
  prefix: string;
  bin: string;
  library: string;
  records: string;
}> {
  const prefix = resolve(prefixInput);
  if (await exists(prefix)) {
    const stat = await lstat(prefix);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`--prefix must be a real directory: ${prefix}`);
  } else {
    await mkdir(prefix, { recursive: true, mode: 0o755 });
  }
  const bin = join(prefix, "bin");
  const library = join(prefix, "lib", "tasq");
  const share = join(prefix, "share");
  const records = join(share, "tasq", "installations");
  for (const path of [bin, join(prefix, "lib"), library, share, join(share, "tasq"), records]) {
    await ensureManagedDirectory(path);
  }
  return { prefix, bin, library, records };
}

function recordPath(records: string, version: string, target: Target): string {
  return join(records, `${version}-${target}.json`);
}

function installationPath(library: string, version: string, target: Target): string {
  return join(library, version, target);
}

async function parseChecksums(path: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const [index, line] of (await readFile(path, "utf8")).trimEnd().split("\n").entries()) {
    const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
    if (!match) fail(`invalid checksum line ${index + 1}`);
    if (result.has(match[2]!)) fail(`duplicate checksum entry: ${match[2]}`);
    result.set(match[2]!, match[1]!);
  }
  return result;
}

async function verifiedManifest(
  manifestPath: string,
  checksumsPath: string,
  archivePath: string,
): Promise<{ manifest: ReleaseManifest; manifestDigest: string; archiveDigest: string }> {
  const checksums = await parseChecksums(checksumsPath);
  const installerPath = fileURLToPath(import.meta.url);
  const installerName = basename(installerPath);
  const manifestName = basename(manifestPath);
  const archiveName = basename(archivePath);
  const checksumsName = basename(checksumsPath);
  const manifestDigest = await sha256(manifestPath);
  const archiveDigest = await sha256(archivePath);
  const installerDigest = await sha256(installerPath);
  if (checksums.get(installerName) !== installerDigest) fail(`installer checksum mismatch: ${installerName}`);
  if (checksums.get(manifestName) !== manifestDigest) fail(`manifest checksum mismatch: ${manifestName}`);
  if (checksums.get(archiveName) !== archiveDigest) fail(`archive checksum mismatch: ${archiveName}`);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReleaseManifest;
  if (manifest.contractVersion !== "tasq.public-release.v1" || manifest.product !== "Tasq Local") {
    fail("unsupported release manifest");
  }
  if (!SEMVER.test(manifest.version)) fail("release manifest has an invalid version");
  if (
    manifest.source?.repository !== "https://github.com/gwendall/tasq" ||
    !/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? "")
  ) fail("release manifest has an invalid source identity");
  if (manifest.target !== hostTarget()) fail(`release target ${manifest.target} does not match host ${hostTarget()}`);
  const releaseRoot = `tasq-v${manifest.version}-${manifest.target}`;
  const expectedNames = {
    archive: `${releaseRoot}.tar.gz`,
    installer: `${releaseRoot}.install.ts`,
    manifest: `${releaseRoot}.release.json`,
    checksums: `${releaseRoot}.SHA256SUMS`,
  };
  if (
    archiveName !== expectedNames.archive || installerName !== expectedNames.installer ||
    manifestName !== expectedNames.manifest || checksumsName !== expectedNames.checksums
  ) fail("release asset names do not match manifest version and target");
  const names = manifest.files.map((file) => file.name);
  if (new Set(names).size !== names.length) fail("release manifest contains duplicate file identities");
  const archive = manifest.files.find((file) => file.name === archiveName);
  if (!archive || !SHA256.test(archive.sha256) || archive.sha256 !== archiveDigest) {
    fail(`release manifest does not authenticate archive: ${archiveName}`);
  }
  const installer = manifest.files.find((file) => file.name === installerName);
  if (!installer || !SHA256.test(installer.sha256) || installer.sha256 !== installerDigest) {
    fail(`release manifest does not authenticate installer: ${installerName}`);
  }
  return { manifest, manifestDigest, archiveDigest };
}

async function run(argv: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) fail(`${argv[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  return { stdout, stderr };
}

function safeArchiveEntry(entry: string, root: string): boolean {
  if (!entry || entry.includes("\\") || isAbsolute(entry)) return false;
  const normalized = normalize(entry).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) return false;
  return normalized === root || normalized.startsWith(`${root}${sep}`);
}

async function validateExtractedTree(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) fail(`release payload contains a symbolic link: ${entry.name}`);
    if (stat.isDirectory()) await validateExtractedTree(child);
    else if (!stat.isFile()) fail(`release payload contains an unsupported file type: ${entry.name}`);
  }
}

async function activate(layout: Awaited<ReturnType<typeof managedLayout>>, record: InstallRecord): Promise<string> {
  const executable = resolve(layout.prefix, record.executable);
  const managedRoot = `${resolve(layout.library)}${sep}`;
  if (!executable.startsWith(managedRoot) || !(await exists(executable))) fail("install record points outside a managed installation");
  const version = (await run([executable, "--version"])).stdout.trim();
  if (version !== record.version && version !== `tasq ${record.version}`) {
    fail(`installed executable reports ${version || "no version"}, expected ${record.version}`);
  }

  const stable = join(layout.bin, "tasq");
  if (await exists(stable)) {
    const stat = await lstat(stable);
    if (!stat.isSymbolicLink()) fail(`refusing to replace unmanaged path: ${stable}`);
  }
  const temporary = join(layout.bin, `.tasq-${randomUUID()}`);
  await symlink(relative(layout.bin, executable), temporary);
  await rename(temporary, stable);
  return stable;
}

async function readRecord(layout: Awaited<ReturnType<typeof managedLayout>>, version: string, target: Target): Promise<InstallRecord> {
  const path = recordPath(layout.records, version, target);
  if (!(await exists(path))) fail(`Tasq ${version} for ${target} is not installed`);
  const record = JSON.parse(await readFile(path, "utf8")) as InstallRecord;
  if (record.contractVersion !== "tasq.install-record.v1" || record.version !== version || record.target !== target) {
    fail(`invalid install record: ${path}`);
  }
  return record;
}

async function install(prefix: string): Promise<Record<string, unknown>> {
  const archivePath = resolve(flag("--archive")!);
  const manifestPath = resolve(flag("--manifest")!);
  const checksumsPath = resolve(flag("--checksums")!);
  const verified = await verifiedManifest(manifestPath, checksumsPath, archivePath);
  const { manifest } = verified;
  const layout = await managedLayout(prefix);
  const root = `tasq-v${manifest.version}-${manifest.target}`;
  const listing = (await run(["tar", "-tzf", archivePath])).stdout.split("\n").filter(Boolean);
  if (listing.length === 0 || listing.some((entry) => !safeArchiveEntry(entry, root))) fail("release archive contains an unsafe path");

  const destination = installationPath(layout.library, manifest.version, manifest.target);
  const recordFile = recordPath(layout.records, manifest.version, manifest.target);
  if (await exists(destination) || await exists(recordFile)) {
    const existing = await readRecord(layout, manifest.version, manifest.target);
    if (existing.archive.sha256 !== verified.archiveDigest || existing.manifest.sha256 !== verified.manifestDigest) {
      fail(`Tasq ${manifest.version} is already installed from different bytes`);
    }
    const activePath = await activate(layout, existing);
    return {
      action: "install",
      status: "already-installed",
      version: manifest.version,
      target: manifest.target,
      activePath,
      dataDisposition: "external-not-managed",
    };
  }

  const staging = await mkdtemp(join(layout.prefix, ".tasq-install-"));
  try {
    await run(["tar", "-xzf", archivePath, "-C", staging]);
    const payload = join(staging, root);
    if (!(await exists(payload)) || !(await lstat(payload)).isDirectory()) fail("release archive is missing its payload root");
    await validateExtractedTree(payload);
    const executable = join(payload, "index.js");
    if (!(await exists(executable))) fail("release payload is missing index.js");
    await chmod(executable, 0o755);
    await mkdir(dirname(destination), { recursive: false, mode: 0o755 });
    await rename(payload, destination);

    const record: InstallRecord = {
      contractVersion: "tasq.install-record.v1",
      version: manifest.version,
      target: manifest.target,
      source: manifest.source,
      archive: { name: basename(archivePath), sha256: verified.archiveDigest },
      manifest: { name: basename(manifestPath), sha256: verified.manifestDigest },
      executable: relative(layout.prefix, join(destination, "index.js")),
      dataDisposition: "external-never-managed",
    };
    const temporaryRecord = `${recordFile}.${randomUUID()}.tmp`;
    await writeFile(temporaryRecord, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    await rename(temporaryRecord, recordFile);
    const activePath = await activate(layout, record);
    return {
      action: "install",
      status: "installed",
      version: manifest.version,
      target: manifest.target,
      activePath,
      dataDisposition: "external-not-managed",
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    await rm(recordFile, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function activateCommand(prefix: string): Promise<Record<string, unknown>> {
  const identity = requestedIdentity();
  const layout = await managedLayout(prefix);
  const record = await readRecord(layout, identity.version, identity.target);
  return {
    action: "activate",
    status: "activated",
    ...identity,
    activePath: await activate(layout, record),
    dataDisposition: "external-not-managed",
  };
}

async function uninstall(prefix: string): Promise<Record<string, unknown>> {
  const identity = requestedIdentity();
  const layout = await managedLayout(prefix);
  const record = await readRecord(layout, identity.version, identity.target);
  const destination = installationPath(layout.library, identity.version, identity.target);
  const stable = join(layout.bin, "tasq");
  let activeLinkRemoved = false;
  if (await exists(stable)) {
    const stat = await lstat(stable);
    if (!stat.isSymbolicLink()) fail(`refusing to alter unmanaged path: ${stable}`);
    const target = resolve(layout.bin, await readlink(stable));
    if (target === resolve(layout.prefix, record.executable)) {
      await rm(stable);
      activeLinkRemoved = true;
    }
  }
  await rm(destination, { recursive: true, force: false });
  await rm(recordPath(layout.records, identity.version, identity.target));
  return {
    action: "uninstall",
    status: "uninstalled",
    ...identity,
    activeLinkRemoved,
    dataDisposition: "preserved-not-touched",
  };
}

async function main(): Promise<void> {
  const selected = command();
  const prefix = flag("--prefix")!;
  const result = selected === "install"
    ? await install(prefix)
    : selected === "activate"
      ? await activateCommand(prefix)
      : await uninstall(prefix);
  process.stdout.write(`${JSON.stringify({ contractVersion: "tasq.lifecycle-result.v1", ...result })}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    contractVersion: "tasq.lifecycle-error.v1",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
