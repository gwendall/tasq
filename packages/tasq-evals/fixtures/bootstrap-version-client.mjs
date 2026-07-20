#!/usr/bin/env node
/** Minimal forward-compatible bootstrap reader with no Tasq package imports. */

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

function fail(code, message) {
  process.stdout.write(JSON.stringify({
    contractVersion: "tasq.fixture-bootstrap-problem.v1",
    status: "error",
    code,
    message,
  }));
  process.exitCode = 1;
}

let document;
try {
  document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  fail("invalid_json", "bootstrap input is not JSON");
}

if (document !== undefined && document.contractVersion !== "tasq.autonomous-bootstrap.v1") {
  fail("unsupported_contract", `unsupported bootstrap contract: ${String(document.contractVersion)}`);
} else if (document !== undefined) {
  const capabilities = new Set(["read", "propose", "coordinate"]);
  const valid = typeof document.space?.workspaceId === "string" &&
    typeof document.actor?.alias === "string" &&
    Array.isArray(document.recipeCapabilities) &&
    document.recipeCapabilities.length > 0 &&
    document.recipeCapabilities.every((capability) => capabilities.has(capability)) &&
    Array.isArray(document.recipes) &&
    document.recipes.every((recipe) =>
      typeof recipe?.id === "string" &&
      recipe.version === 1 &&
      capabilities.has(recipe.requiredCapability) &&
      document.recipeCapabilities.includes(recipe.requiredCapability) &&
      typeof recipe.outputContract === "string" &&
      Array.isArray(recipe.argvTemplate) &&
      recipe.argvTemplate.length >= 2 &&
      recipe.argvTemplate.every((part) => typeof part === "string" && part.length > 0) &&
      Array.isArray(recipe.parameters) &&
      (() => {
        const declared = recipe.parameters.map((parameter) => parameter.placeholder);
        const used = recipe.argvTemplate.filter((part) => /^\{[a-z][a-zA-Z0-9]*\}$/.test(part));
        return declared.every((placeholder) => /^\{[a-z][a-zA-Z0-9]*\}$/.test(placeholder)) &&
          new Set(declared).size === declared.length &&
          new Set(used).size === used.length &&
          declared.length === used.length &&
          declared.every((placeholder) => used.includes(placeholder));
      })());
  const uniqueRecipeIds = valid && new Set(document.recipes.map((recipe) => recipe.id)).size === document.recipes.length;
  const uniqueCapabilities = valid && new Set(document.recipeCapabilities).size === document.recipeCapabilities.length;
  if (!valid || !uniqueRecipeIds || !uniqueCapabilities) {
    fail("invalid_shape", "v1 bootstrap is missing a required field");
  } else {
    // Unknown fields are deliberately ignored within a recognized contract.
    process.stdout.write(JSON.stringify({
      contractVersion: document.contractVersion,
      space: document.space.workspaceId,
      actor: document.actor.alias,
      recipeIds: document.recipes.map((recipe) => recipe.id),
    }));
  }
}
