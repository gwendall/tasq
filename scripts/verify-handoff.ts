#!/usr/bin/env bun

import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const quick = process.argv.includes("--quick");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--quick");
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(", ")}`);
  process.exit(2);
}

const steps: Array<{ name: string; argv: string[] }> = [
  { name: "diff integrity", argv: ["git", "diff", "--check"] },
  { name: "documentation contracts", argv: ["pnpm", "docs:check"] },
  { name: "workspace typecheck", argv: ["pnpm", "typecheck"] },
  ...(!quick ? [{ name: "complete test suite", argv: ["pnpm", "test"] }] : []),
];

for (const step of steps) {
  console.log(`\n[verify:handoff] ${step.name}`);
  const child = Bun.spawn(step.argv, {
    cwd: repositoryRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    console.error(`[verify:handoff] failed: ${step.name}`);
    process.exit(exitCode);
  }
}

console.log(`\n[verify:handoff] ${quick ? "quick" : "full"} verification passed`);
