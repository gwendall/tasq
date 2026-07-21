#!/usr/bin/env node
/** Unknown Node client: knows the public adoption/bootstrap JSON contracts, not Tasq code. */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const manifest = JSON.parse(readFileSync(request.manifestPath, "utf8"));

if (
  manifest.contractVersion !== "tasq.public-adoption.v1" ||
  manifest.distribution?.published !== false ||
  manifest.distribution?.mode !== "source_build" ||
  !Array.isArray(manifest.agent?.onboardArgvTemplate)
) {
  throw new Error("unsupported, malformed or falsely published adoption manifest");
}

function replaceVector(vector, replacements) {
  return vector.map((part) => {
    const result = replacements[part] ?? part;
    if (/^\{[^}]+\}$/.test(result)) throw new Error(`unresolved argv placeholder: ${result}`);
    return result;
  });
}

function run(argv) {
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd: request.cwd,
    env: process.env,
    encoding: "utf8",
  });
  let stdout;
  try {
    stdout = JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(
      `command returned non-JSON stdout: ${JSON.stringify(child.stdout)}; stderr=${JSON.stringify(child.stderr)}`,
      { cause: error },
    );
  }
  return { exitCode: child.status, stdout, stderr: child.stderr };
}

const pointerArgv = replaceVector(manifest.agent.onboardArgvTemplate, request.onboardReplacements);
const bootstrap = run(pointerArgv);
const results = [];
if (bootstrap.exitCode === 0) {
  if (
    bootstrap.stdout?.contractVersion !== "tasq.autonomous-bootstrap.v1" ||
    !Array.isArray(bootstrap.stdout.recipes)
  ) throw new Error("unsupported or malformed autonomous bootstrap response");

  for (const action of request.actions ?? []) {
    const selector = action.selector;
    const expectedParameters = [...(selector.parameterNames ?? [])].sort();
    const matches = bootstrap.stdout.recipes.filter((candidate) =>
      candidate.outputContract === selector.outputContract &&
      candidate.mutates === selector.mutates &&
      candidate.requiredCapability === selector.requiredCapability &&
      JSON.stringify(candidate.parameters.map((parameter) => parameter.name).sort()) ===
        JSON.stringify(expectedParameters));
    if (matches.length !== 1) {
      throw new Error(`semantic selector matched ${matches.length} recipes: ${JSON.stringify(selector)}`);
    }
    const recipe = matches[0];
    const declared = recipe.parameters.map((parameter) => parameter.placeholder).sort();
    const supplied = Object.keys(action.replacements ?? {}).sort();
    if (JSON.stringify(declared) !== JSON.stringify(supplied)) {
      throw new Error(`recipe parameters differ: declared=${declared}, supplied=${supplied}`);
    }
    results.push({ selectedRecipeId: recipe.id, ...run(replaceVector(recipe.argvTemplate, action.replacements)) });
  }
}

process.stdout.write(`${JSON.stringify({ manifestContract: manifest.contractVersion, bootstrap, results })}\n`);
