#!/usr/bin/env bun

import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

interface Inputs {
  version: string;
  sourceCommit: string;
  outdir: string;
}

interface PublicPackage {
  name: string;
  sourceDirectory: string;
  description: string;
  entrypoint: string;
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  copyMode: "all-source" | "core-graph" | "cli-bundle";
}

const productRoot = resolve(import.meta.dir, "../..");
const packagesRoot = join(productRoot, "packages");
const importRewrites = new Map([
  ["@tasq/schema", "@tasq/schema"],
  ["@tasq/extension-sdk", "@tasq/extension-sdk"],
  ["@tasq/core", "@tasq/core"],
  ["@tasq/mcp", "@tasq/mcp"],
  ["@tasq/protocol-adapters", "@tasq/protocol-adapters"],
  ["@tasq/console", "@tasq/console"],
]);

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function parseInputs(): Inputs {
  const version = requiredFlag("--version");
  const sourceCommit = requiredFlag("--source-commit");
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`--version must be SemVer: ${version}`);
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("--source-commit must be a lowercase 40-character Git commit");
  return { version, sourceCommit, outdir: resolve(requiredFlag("--outdir")) };
}

async function selectedDependencies(
  sourceDirectory: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const source = JSON.parse(await readFile(
    join(packagesRoot, sourceDirectory, "package.json"),
    "utf8",
  )) as { dependencies?: Record<string, string> };
  return Object.fromEntries(names.map((name) => {
    const version = source.dependencies?.[name];
    if (!version || version.startsWith("workspace:")) {
      throw new Error(`Missing external dependency ${name} in packages/${sourceDirectory}/package.json`);
    }
    return [name, version];
  }));
}

async function definitions(version: string): Promise<PublicPackage[]> {
  return [
    {
      name: "@tasq/schema",
      sourceDirectory: "tasq-schema",
      description: "Portable schemas, identifiers and clock contracts for Tasq.",
      entrypoint: "./src/index.ts",
      exports: {
        ".": "./src/index.ts",
        "./tables": "./src/tables.ts",
        "./types": "./src/types.ts",
        "./extensions": "./src/extensions.ts",
        "./discovery": "./src/discovery.ts",
        "./effects": "./src/effects.ts",
        "./replication": "./src/replication.ts",
        "./bootstrap": "./src/bootstrap.ts",
        "./resources": "./src/resources.ts",
        "./context": "./src/context.ts",
        "./summaries": "./src/summaries.ts",
        "./clock": "./src/clock.ts",
        "./ids": "./src/ids.ts",
        "./console": "./src/console.ts",
      },
      dependencies: await selectedDependencies("tasq-schema", ["drizzle-orm", "zod"]),
      copyMode: "all-source",
    },
    {
      name: "@tasq/extension-sdk",
      sourceDirectory: "tasq-extension-sdk",
      description: "DB-free extension and connector contracts for Tasq.",
      entrypoint: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      dependencies: { "@tasq/schema": version },
      copyMode: "all-source",
    },
    {
      name: "@tasq/core",
      sourceDirectory: "tasq-core",
      description: "Universal runtime-neutral commitment coordination kernel for Tasq.",
      entrypoint: "./src/kernel.ts",
      exports: { ".": "./src/kernel.ts" },
      dependencies: {
        "@tasq/extension-sdk": version,
        "@tasq/schema": version,
        ...await selectedDependencies("tasq-core", ["@libsql/client", "drizzle-orm", "zod"]),
      },
      copyMode: "core-graph",
    },
    {
      name: "@tasq/mcp",
      sourceDirectory: "tasq-mcp",
      description: "Capability-scoped local stdio MCP transport for Tasq Core.",
      entrypoint: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      bin: { "tasq-mcp": "./src/stdio.ts" },
      dependencies: {
        "@tasq/core": version,
        "@tasq/schema": version,
        ...await selectedDependencies("tasq-mcp", ["@modelcontextprotocol/sdk", "zod"]),
      },
      copyMode: "all-source",
    },
    {
      name: "@tasq/protocol-adapters",
      sourceDirectory: "tasq-protocol-adapters",
      description: "Commitment-safe MCP Tasks and A2A execution adapters for Tasq.",
      entrypoint: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      dependencies: {
        "@tasq/core": version,
        "@tasq/schema": version,
        ...await selectedDependencies("tasq-protocol-adapters", ["zod"]),
      },
      copyMode: "all-source",
    },
    {
      name: "@tasq/console",
      sourceDirectory: "tasq-inspector",
      description: "Read-only loopback Console primitives for Tasq Local.",
      entrypoint: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      dependencies: { "@tasq/core": version, "@tasq/schema": version },
      copyMode: "all-source",
    },
    {
      name: "@tasq/cli",
      sourceDirectory: "tasq-cli",
      description: "Standalone local-first Tasq command-line agent and human interface.",
      entrypoint: "./index.js",
      bin: { tasq: "./index.js" },
      optionalDependencies: {
        "@libsql/darwin-arm64": "0.4.7",
        "@libsql/linux-x64-gnu": "0.4.7",
      },
      copyMode: "cli-bundle",
    },
  ];
}

function manifest(definition: PublicPackage, inputs: Inputs) {
  return {
    name: definition.name,
    version: inputs.version,
    description: definition.description,
    license: "Apache-2.0",
    type: "module",
    main: definition.entrypoint,
    types: definition.copyMode === "cli-bundle" ? undefined : definition.entrypoint,
    exports: definition.exports,
    bin: definition.bin,
    files: definition.copyMode === "cli-bundle"
      ? ["index.js", "artifact.json", "*.sql", "LICENSE", "README.md"]
      : ["src", "LICENSE", "README.md"],
    engines: { bun: ">=1.3.0" },
    repository: {
      type: "git",
      url: "git+https://github.com/gwendall/tasq.git",
      directory: `packages/${definition.sourceDirectory}`,
    },
    gitHead: inputs.sourceCommit,
    bugs: { url: "https://github.com/gwendall/tasq/issues" },
    homepage: "https://tasq.run",
    publishConfig: { access: "public", provenance: true },
    dependencies: definition.dependencies,
    optionalDependencies: definition.optionalDependencies,
  };
}

async function allFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await stat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) output.push(path);
      else throw new Error(`Unsupported package source entry: ${path}`);
    }
  }
  await visit(root);
  return output;
}

function rewriteImports(source: string): string {
  let output = source;
  for (const [from, to] of importRewrites) output = output.split(from).join(to);
  return output;
}

async function copySourceFile(sourceRoot: string, sourcePath: string, destinationRoot: string): Promise<void> {
  const destination = join(destinationRoot, relative(sourceRoot, sourcePath));
  await mkdir(dirname(destination), { recursive: true });
  if (sourcePath.endsWith(".ts")) {
    const rewritten = rewriteImports(await readFile(sourcePath, "utf8"));
    if (/from\s+["']@kami\//.test(rewritten) || /import\s*\(\s*["']@kami\//.test(rewritten)) {
      throw new Error(`Private package import remains in ${sourcePath}`);
    }
    await writeFile(destination, rewritten, "utf8");
  } else {
    await copyFile(sourcePath, destination);
  }
}

function relativeSpecifiers(source: string): string[] {
  const matches = source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g);
  return [...matches].map((match) => match[1] ?? match[2]).filter((value): value is string => Boolean(value));
}

async function resolveModule(from: string, specifier: string, sourceRoot: string): Promise<string> {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ".ts"));
  const candidates = [base, `${base}.ts`, join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        if (!candidate.startsWith(`${sourceRoot}${sep}`)) throw new Error(`Core import escapes source root: ${specifier}`);
        return candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

async function coreGraph(sourceRoot: string): Promise<string[]> {
  const pending = [join(sourceRoot, "kernel.ts")];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = await readFile(path, "utf8");
    for (const specifier of relativeSpecifiers(source)) pending.push(await resolveModule(path, specifier, sourceRoot));
  }
  const migrationRoot = join(sourceRoot, "migrations");
  for (const path of await allFiles(migrationRoot)) if (path.endsWith(".sql")) seen.add(path);
  return [...seen].sort();
}

function packageUsage(definition: PublicPackage): string {
  const install = `npm install ${definition.name}`;
  switch (definition.name) {
    case "@tasq/cli":
      return `## Start\n\n\`\`\`bash\n${install}\nnpx tasq onboard --space my-context --actor agent:local --json\n\`\`\`\n\nExecute the returned argument-vector recipes directly. Read before mutating, persist numeric event sequences, claim before autonomous work and keep attempt success distinct from commitment completion.`;
    case "@tasq/core":
      return `## Start\n\n\`\`\`bash\n${install}\n\`\`\`\n\nOpen an explicit store, run checksum-pinned kernel migrations, inject a \`Clock\`, install only trusted provider-neutral extension manifests, and pass explicit \`workspaceId\`, actor and retry identity to every mutation. Core owns commitments, collaboration, claims, attempts, evidence, resources, audit and replication; the embedding runtime owns execution, credentials, provider policy and transport.`;
    case "@tasq/schema":
      return `## Start\n\n\`\`\`bash\n${install}\n\`\`\`\n\nImport portable records, validators, identifiers and clock contracts from \`@tasq/schema\`. These schemas describe coordination data; they do not grant authentication, effect authority or provider access.`;
    case "@tasq/mcp":
      return `## Start\n\n\`\`\`bash\n${install}\nnpx tasq-mcp --help\n\`\`\`\n\nEmbed \`createTasqMcpServer()\` when the host owns the store and injected identity, or launch the local stdio composition returned by \`tasq onboard\`. Generic stdio exposes only host-selected capabilities and never grants effect dispatch authority.`;
    case "@tasq/extension-sdk":
      return `## Start\n\n\`\`\`bash\n${install}\n\`\`\`\n\nUse \`defineExtensionRuntime()\` and the connector conformance helpers to declare immutable provider-neutral types and evaluators. Credentials, network I/O and domain policy stay in the host or connector, never in Core.`;
    case "@tasq/protocol-adapters":
      return `## Start\n\n\`\`\`bash\n${install}\n\`\`\`\n\nUse the pure MCP Tasks and A2A mappings to import external execution state as attempts and artifacts. Remote success never becomes commitment completion without a separate evidence-aware decision.`;
    case "@tasq/console":
      return `## Start\n\n\`\`\`bash\n${install}\n\`\`\`\n\nEmbed the bounded read models and loopback Console server in a trusted local composition. The Console is read-only, foreground and loopback-only; it is not an authenticated hosted UI or an agent API.`;
    default:
      throw new Error(`Missing public package README guidance for ${definition.name}`);
  }
}

async function writeReadme(stage: string, definition: PublicPackage): Promise<void> {
  const text = `# ${definition.name}\n\n${definition.description}\n\n` +
    `${packageUsage(definition)}\n\n` +
    "## Runtime and support\n\nBun 1.3 or newer is the initial certified runtime; Node.js support is not yet certified. " +
    "This package is generated deterministically from the canonical Tasq source tree.\n\n" +
    "Source, full documentation, security policy and release provenance: https://github.com/gwendall/tasq\n";
  await writeFile(join(stage, "README.md"), text, "utf8");
}

async function stagePackage(definition: PublicPackage, inputs: Inputs, stage: string): Promise<void> {
  await mkdir(stage, { recursive: true });
  const sourceRoot = join(packagesRoot, definition.sourceDirectory, "src");
  if (definition.copyMode === "all-source") {
    for (const path of await allFiles(sourceRoot)) await copySourceFile(sourceRoot, path, join(stage, "src"));
  } else if (definition.copyMode === "core-graph") {
    for (const path of await coreGraph(sourceRoot)) await copySourceFile(sourceRoot, path, join(stage, "src"));
  } else {
    const build = Bun.spawn([
      process.execPath,
      join(packagesRoot, "tasq-cli", "scripts/build.ts"),
      "--version",
      inputs.version,
      "--outdir",
      stage,
    ], { cwd: productRoot, stdout: "pipe", stderr: "inherit" });
    if (await build.exited !== 0) throw new Error("CLI npm package build failed");
    await rm(join(stage, "node_modules"), { recursive: true, force: true });
  }
  await copyFile(join(productRoot, "LICENSE"), join(stage, "LICENSE"));
  await writeReadme(stage, definition);
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest(definition, inputs), null, 2)}\n`, "utf8");
  if (definition.bin) {
    for (const path of Object.values(definition.bin)) await chmod(join(stage, path), 0o755);
  }
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(path));
  return hasher.digest("hex");
}

async function pack(stage: string, outdir: string): Promise<string> {
  const child = Bun.spawn([
    "npm",
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    outdir,
  ], { cwd: stage, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`npm pack failed in ${stage}: ${stderr || stdout}`);
  const result = JSON.parse(stdout) as Array<{ filename?: string }>;
  const filename = result[0]?.filename;
  if (!filename) throw new Error(`npm pack returned no filename for ${stage}`);
  return filename;
}

function packagePurl(name: string, version: string): string {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

async function main(): Promise<void> {
  const inputs = parseInputs();
  const work = join(inputs.outdir, ".work");
  await rm(inputs.outdir, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const artifacts: Array<{ name: string; version: string; filename: string; sha256: string; dependencies: string[] }> = [];
  for (const definition of await definitions(inputs.version)) {
    const stage = join(work, definition.name.replace("@", "").replace("/", "-"));
    await stagePackage(definition, inputs, stage);
    const filename = await pack(stage, inputs.outdir);
    artifacts.push({
      name: definition.name,
      version: inputs.version,
      filename,
      sha256: await sha256(join(inputs.outdir, filename)),
      dependencies: Object.keys(definition.dependencies ?? {}).filter((name) => name.startsWith("@tasq/")),
    });
  }
  artifacts.sort((left, right) => left.name.localeCompare(right.name));

  const prefix = `tasq-packages-v${inputs.version}`;
  const sbomName = `${prefix}.cdx.json`;
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { type: "application", name: "Tasq public package set", version: inputs.version },
      properties: [
        { name: "tasq:sourceCommit", value: inputs.sourceCommit },
        { name: "tasq:authoritativeTime", value: "not-read-build-inputs-only" },
      ],
    },
    components: artifacts.map((artifact) => ({
      type: "library",
      "bom-ref": packagePurl(artifact.name, artifact.version),
      group: "tasq",
      name: artifact.name.slice("@tasq/".length),
      version: artifact.version,
      licenses: [{ license: { id: "Apache-2.0" } }],
      hashes: [{ alg: "SHA-256", content: artifact.sha256 }],
      purl: packagePurl(artifact.name, artifact.version),
    })),
    dependencies: artifacts.map((artifact) => ({
      ref: packagePurl(artifact.name, artifact.version),
      dependsOn: artifact.dependencies.map((name) => packagePurl(name, inputs.version)).sort(),
    })),
  };
  await writeFile(join(inputs.outdir, sbomName), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

  const releaseName = `${prefix}.release.json`;
  await writeFile(join(inputs.outdir, releaseName), `${JSON.stringify({
    contractVersion: "tasq.public-packages.v1",
    version: inputs.version,
    source: { repository: "https://github.com/gwendall/tasq", commit: inputs.sourceCommit },
    runtime: { name: "bun", minimumVersion: "1.3.0" },
    packages: artifacts,
    provenance: {
      requiredBuilder: "protected-github-actions-tag-workflow",
      npmPublishing: "trusted-publishing-oidc",
      localArtifactsPublishable: false,
    },
    clockBoundary: "explicit inputs only; no device time is package authority",
  }, null, 2)}\n`, "utf8");

  const checksumFiles = [...artifacts.map(({ filename }) => filename), sbomName, releaseName].sort();
  const lines = await Promise.all(checksumFiles.map(async (filename) => `${await sha256(join(inputs.outdir, filename))}  ${filename}`));
  await writeFile(join(inputs.outdir, `${prefix}.SHA256SUMS`), `${lines.join("\n")}\n`, "utf8");
  await rm(work, { recursive: true, force: true });
  console.log(`Built ${artifacts.length} Tasq public package candidates: ${inputs.outdir}`);
}

await main();
