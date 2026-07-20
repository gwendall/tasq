#!/usr/bin/env bun

import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

interface BundledArtifactComponent {
  name: string;
  version: string;
  license: string;
  purl: string;
}

interface NativeArtifactManifest {
  contractVersion: "tasq.cli-artifact.v1";
  entrypoint: "index.js";
  nativePackages: Array<{
    package: string;
    target: string;
    sha256: string;
  }>;
  migrations: Array<{
    name: string;
    sha256: string;
  }>;
  runtime: {
    name: "bun";
    minimumVersion: "1.3.0";
  };
  bundledComponents: BundledArtifactComponent[];
}

function outputDirectory(): string {
  const index = process.argv.indexOf("--outdir");
  if (index === -1) return resolve(import.meta.dir, "../dist");
  const value = process.argv[index + 1];
  if (!value) throw new Error("--outdir requires a directory");
  return resolve(value);
}

function buildVersion(): string {
  const index = process.argv.indexOf("--version");
  if (index === -1) return "0.1.0";
  const value = process.argv[index + 1];
  if (!value || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("--version requires a SemVer release version");
  }
  return value;
}

function releaseDependencies(): {
  migrationDirectory: string;
  libsqlDirectory: string;
  native: { packageName: string; entrypoint: string; packageJson: string; target: string };
} {
  const requireFromCli = createRequire(import.meta.url);
  const serviceEntrypoint = requireFromCli.resolve("@tasq-internal/local-service");
  const requireFromService = createRequire(serviceEntrypoint);
  const clientEntrypoint = requireFromService.resolve("@libsql/client");
  const requireFromClient = createRequire(clientEntrypoint);
  const libsqlEntrypoint = requireFromClient.resolve("libsql");
  const requireFromLibsql = createRequire(libsqlEntrypoint);
  const { currentTarget } = requireFromLibsql("@neon-rs/load") as { currentTarget(): string };
  const { familySync, GLIBC } = requireFromLibsql("detect-libc") as {
    familySync(): string | null;
    GLIBC: string;
  };

  let target = currentTarget();
  // Keep this in lockstep with libsql's loader. Bun identifies Linux as musl
  // even when the host is glibc, while the native package must match the host.
  if (familySync() === GLIBC) {
    if (target === "linux-x64-musl") target = "linux-x64-gnu";
    if (target === "linux-arm64-musl") target = "linux-arm64-gnu";
  }
  const packageName = `@libsql/${target}`;
  return {
    migrationDirectory: join(dirname(serviceEntrypoint), "migrations"),
    libsqlDirectory: dirname(libsqlEntrypoint),
    native: {
      packageName,
      entrypoint: requireFromLibsql.resolve(packageName),
      packageJson: requireFromLibsql.resolve(`${packageName}/package.json`),
      target,
    },
  };
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(path));
  return hasher.digest("hex");
}

function packageNameFromInput(input: string): string | null {
  const marker = `${sep}node_modules${sep}`;
  const absolute = resolve(input);
  const index = absolute.lastIndexOf(marker);
  if (index === -1) return null;
  const segments = absolute.slice(index + marker.length).split(sep);
  if (segments[0]?.startsWith("@")) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  return segments[0] ?? null;
}

function packageRootFromInput(input: string, packageName: string): string {
  const absolute = resolve(input);
  const suffix = `${sep}node_modules${sep}${packageName.split("/").join(sep)}`;
  const index = absolute.lastIndexOf(suffix);
  if (index === -1) throw new Error(`Cannot resolve package root for ${input}`);
  return absolute.slice(0, index + suffix.length);
}

function normalizedLicense(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "type" in value) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && type.trim()) return type.trim();
  }
  return "NOASSERTION";
}

function npmPurl(name: string, version: string): string {
  const encoded = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

function publicComponentIdentity(name: string, version: string): Pick<BundledArtifactComponent, "name" | "purl"> {
  const publicPackages: Record<string, string> = {
    "@tasq/cli": "@tasq/cli",
    "@tasq/extension-sdk": "@tasq/extension-sdk",
    "@tasq/console": "@tasq/console",
    "@tasq/mcp": "@tasq/mcp",
    "@tasq/schema": "@tasq/schema",
    "@tasq-internal/local-service": "@tasq/core",
  };
  const publicName = publicPackages[name];
  if (publicName) return { name: publicName, purl: npmPurl(publicName, version) };
  if (name.startsWith("@tasq/")) return { name, purl: npmPurl(name, version) };
  if (name.startsWith("@tasq-internal/")) {
    const genericName = `tasq-${name.slice("@tasq-internal/".length)}`;
    return { name: genericName, purl: `pkg:generic/${encodeURIComponent(genericName)}@${encodeURIComponent(version)}` };
  }
  if (name.startsWith("@kami/tasq-")) {
    const genericName = name.slice("@kami/".length);
    return { name: genericName, purl: `pkg:generic/${encodeURIComponent(genericName)}@${encodeURIComponent(version)}` };
  }
  return { name, purl: npmPurl(name, version) };
}

async function bundledComponents(inputs: string[], nativePackageJson: string): Promise<BundledArtifactComponent[]> {
  const manifests = new Map<string, string>();
  const productPackages = resolve(import.meta.dir, "../..");
  for (const input of inputs) {
    const absolute = resolve(input);
    if (absolute.startsWith(`${productPackages}${sep}`)) {
      const packageDirectory = absolute.slice(productPackages.length + 1).split(sep)[0];
      if (packageDirectory) manifests.set(`workspace:${packageDirectory}`, join(productPackages, packageDirectory, "package.json"));
      continue;
    }
    const name = packageNameFromInput(input);
    if (name) manifests.set(`npm:${name}`, join(packageRootFromInput(input, name), "package.json"));
  }
  manifests.set("native", nativePackageJson);

  const components: BundledArtifactComponent[] = [];
  for (const manifestPath of manifests.values()) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name?: string;
      version?: string;
      license?: unknown;
    };
    if (!manifest.name || !manifest.version) throw new Error(`Invalid dependency manifest: ${manifestPath}`);
    const internal = resolve(manifestPath).startsWith(`${productPackages}${sep}`);
    const identity = publicComponentIdentity(manifest.name, manifest.version);
    components.push({
      name: identity.name,
      version: manifest.version,
      license: internal ? "Apache-2.0" : normalizedLicense(manifest.license),
      purl: identity.purl,
    });
  }
  components.sort((left, right) => left.purl.localeCompare(right.purl));
  const missing = components.filter((component) => component.license === "NOASSERTION");
  if (missing.length > 0) {
    throw new Error(`Bundled dependencies without declared licenses: ${missing.map((item) => item.purl).join(", ")}`);
  }
  return components;
}

async function removeBuildMachinePath(entrypoint: string, libsqlDirectory: string): Promise<void> {
  const source = await readFile(entrypoint, "utf8");
  const declaration = `var __dirname = ${JSON.stringify(libsqlDirectory)};`;
  const occurrences = source.split(declaration).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one bundled libsql build path, found ${occurrences}`);
  }
  const sanitized = source.replace(declaration, "var __dirname = import.meta.dir;");
  if (sanitized.includes(resolve(process.cwd()))) {
    throw new Error("CLI bundle contains an absolute build-workspace path");
  }
  await writeFile(entrypoint, sanitized, "utf8");
}

async function main(): Promise<void> {
  const outdir = outputDirectory();
  await rm(outdir, { recursive: true, force: true });
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/index.ts")],
    outdir,
    target: "bun",
    metafile: true,
    define: { TASQ_BUILD_VERSION: JSON.stringify(buildVersion()) },
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    process.exitCode = 1;
    return;
  }

  const entrypoint = join(outdir, "index.js");
  await chmod(entrypoint, 0o755);

  // libsql selects its native binding with a dynamic require. Bundling moves
  // that require beside index.js, so the matching binding must travel with the
  // release artifact instead of being found accidentally in a workspace.
  const dependencies = releaseDependencies();
  const native = dependencies.native;
  await removeBuildMachinePath(entrypoint, dependencies.libsqlDirectory);
  const nativeDir = join(outdir, "node_modules", "@libsql", native.target);
  await mkdir(nativeDir, { recursive: true });
  const nativeEntrypoint = join(nativeDir, "index.node");
  await copyFile(native.entrypoint, nativeEntrypoint);
  await copyFile(native.packageJson, join(nativeDir, "package.json"));

  // The migration runner intentionally reads immutable SQL files so it can
  // checksum and audit them. A bundle must therefore ship those files beside
  // the bundled entrypoint, where import.meta.url resolves at runtime.
  const migrationNames = (await readdir(dependencies.migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const migrations: NativeArtifactManifest["migrations"] = [];
  for (const name of migrationNames) {
    const source = join(dependencies.migrationDirectory, name);
    const destination = join(outdir, name);
    await copyFile(source, destination);
    migrations.push({ name, sha256: await sha256(destination) });
  }
  if (migrations.length === 0) throw new Error("No Tasq SQL migrations found for the release artifact");

  const manifest: NativeArtifactManifest = {
    contractVersion: "tasq.cli-artifact.v1",
    entrypoint: "index.js",
    nativePackages: [{
      package: native.packageName,
      target: native.target,
      sha256: await sha256(nativeEntrypoint),
    }],
    migrations,
    runtime: {
      name: "bun",
      minimumVersion: "1.3.0",
    },
    bundledComponents: await bundledComponents(
      Object.keys(build.metafile?.inputs ?? {}).map((input) => resolve(input)),
      native.packageJson,
    ),
  };
  await writeFile(join(outdir, "artifact.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Built Tasq CLI artifact for ${native.target}: ${outdir}`);
}

await main();
