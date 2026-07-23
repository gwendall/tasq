#!/usr/bin/env node
/** Package-independent JS client: knows JSON/processes, not Tasq packages. */

import { spawnSync } from "node:child_process";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));

function run(argv) {
  // Maximum legal space/actor identifiers are repeated in each executable
  // recipe. Keep the independent client bounded, but above Node's
  // platform-dependent synchronous pipe buffer so valid bootstrap JSON is
  // never truncated before parsing.
  const child = spawnSync(argv[0], argv.slice(1), {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  let stdout;
  try {
    stdout = JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(`command returned non-JSON stdout: ${JSON.stringify(child.stdout)}; stderr=${JSON.stringify(child.stderr)}`, { cause: error });
  }
  return { exitCode: child.status, stdout, stderr: child.stderr };
}

const bootstrap = run(request.pointerArgv);
const results = [];
if (bootstrap.exitCode === 0) {
  if (bootstrap.stdout?.contractVersion !== "tasq.autonomous-bootstrap.v1" || !Array.isArray(bootstrap.stdout.recipes)) {
    throw new Error(`unsupported or malformed bootstrap contract: ${String(bootstrap.stdout?.contractVersion)}`);
  }
  for (const action of request.actions ?? []) {
    const selector = action.selector;
    const matches = selector
      ? bootstrap.stdout.recipes.filter((candidate) =>
          candidate.outputContract === selector.outputContract &&
          candidate.mutates === selector.mutates &&
          (selector.requiredCapability === undefined ||
            candidate.requiredCapability === selector.requiredCapability) &&
          JSON.stringify(candidate.parameters.map((parameter) => parameter.name).sort()) ===
            JSON.stringify([...(selector.parameterNames ?? [])].sort()))
      : bootstrap.stdout.recipes.filter((candidate) => candidate.id === action.recipeId);
    const selectionLabel = selector ? JSON.stringify(selector) : action.recipeId;
    if (matches.length !== 1) throw new Error(`discovery must advertise exactly one recipe matching ${selectionLabel}`);
    const recipe = matches[0];
    if (recipe.version !== 1 || !Array.isArray(recipe.argvTemplate) || !Array.isArray(recipe.parameters)) {
      throw new Error(`unsupported or malformed selected recipe ${String(recipe.id)}`);
    }
    const declared = recipe.parameters.map((parameter) => parameter.placeholder).sort();
    const supplied = Object.keys(action.replacements ?? {}).sort();
    if (JSON.stringify(declared) !== JSON.stringify(supplied)) {
      throw new Error(`recipe parameters differ: declared=${declared}, supplied=${supplied}`);
    }
    const argv = recipe.argvTemplate.map((part) => action.replacements[part] ?? part);
    results.push({ selectedRecipeId: recipe.id, ...run(argv) });
  }
}

process.stdout.write(JSON.stringify({ bootstrap, results }) + (request.holdAfterResult ? "\n" : ""));
if (request.holdAfterResult) setInterval(() => {}, 60_000);
