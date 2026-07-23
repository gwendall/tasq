import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const requested = process.env.TASQ_PUBLISHED_NPM_VERSION;
const version = requested?.replace(/^v/, "");
const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "../..");

setDefaultTimeout(180_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
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

describe("published embedded TypeScript client", () => {
  (version ? test : test.skip)("restarts the exact registry package under Node and Bun", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-published-embedded-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@tasq-run/core": version },
    }, null, 2)}\n`, "utf8");
    const installed = await run([
      "npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    ], root);
    expect(installed.exitCode, installed.stderr || installed.stdout).toBe(0);

    const manifest = JSON.parse(await readFile(
      join(root, "node_modules", "@tasq-run", "core", "package.json"),
      "utf8",
    ));
    expect(manifest).toMatchObject({
      name: "@tasq-run/core",
      version,
      main: "./dist/kernel.js",
      types: "./dist/kernel.d.ts",
      engines: { bun: ">=1.3.0", node: ">=22" },
    });

    const example = join(root, "local-client.mjs");
    await copyFile(
      join(repositoryRoot, "packages", "tasq-core", "examples", "local-client.mjs"),
      example,
    );
    for (const runtime of [
      { name: "node", command: ["node", example] },
      { name: "bun", command: [process.execPath, "run", example] },
    ]) {
      const store = `file:${join(root, `${runtime.name}.sqlite`)}`;
      const first = await run(runtime.command, root, { TASQ_DB_URL: store });
      expect(first.exitCode, `${runtime.name}: ${first.stderr}`).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({ status: "done" });
      const second = await run(runtime.command, root, { TASQ_DB_URL: store });
      expect(second.exitCode, `${runtime.name}: ${second.stderr}`).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
    }
  });
});
