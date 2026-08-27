/**
 * The onboard recipes are handed to agents as EXECUTABLE argv. Nothing ran one.
 *
 * `tasq onboard --json` returns dozens of recipes with a version, a required
 * capability and an argv template, and an agent is told to execute the vector
 * verbatim. Until now no test invoked a single one, so a recipe naming a verb
 * the CLI does not have would have shipped silently - the same shape as a
 * capability advertised with no wire surface, or a rollback rule with no
 * command behind it.
 */

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "src", "index.ts");
const productRoot = resolve(packageRoot, "../..");
const temporary: string[] = [];
setDefaultTimeout(120_000);

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

interface Recipe {
  id: string;
  requiredCapability: string;
  mutates: boolean;
  argvTemplate: string[];
  parameters: Array<{ name: string }>;
  outputContract: string;
}

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "tasq-recipes-"));
  temporary.push(base);
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true });
  return { home, project };
}

async function run(home: string, project: string, argv: string[]) {
  const child = Bun.spawn(["bun", "run", ...argv], {
    cwd: project,
    env: { PATH: process.env.PATH ?? "", HOME: home, TASQ_DB_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function ok(home: string, project: string, argv: string[]) {
  const result = await run(home, project, argv);
  expect(result.exitCode, `${argv.join(" ")}\n${result.stderr}`).toBe(0);
  return result;
}

/** Run a recipe exactly as an agent is told to: substitute, then execute. */
async function execute(
  home: string,
  project: string,
  recipe: Recipe,
  values: Record<string, string>,
) {
  const argv = recipe.argvTemplate.map((token) => {
    const match = /^\{(.+)\}$/.exec(token);
    if (!match) return token;
    const value = values[match[1]!];
    if (value === undefined) throw new Error(`${recipe.id} needs ${match[1]}`);
    return value;
  });
  // argvTemplate[0] is the producing executable; under test that is this source.
  return ok(home, project, [cli, ...argv.slice(1)]);
}

async function onboard(home: string, project: string): Promise<Recipe[]> {
  const result = await ok(home, project, [
    cli, "onboard", "--space", "recipes/test", "--actor", "agent-a", "--json",
  ]);
  return JSON.parse(result.stdout).recipes as Recipe[];
}

describe("onboard recipes", () => {
  test("every recipe names a verb this CLI actually dispatches", async () => {
    // The inventory classifies every top-level command exactly once, which
    // makes it the registry to check argv against. A recipe naming a verb that
    // does not exist is a vector an agent would run and an error it could not
    // act on.
    const { home, project } = sandbox();
    const inventory = JSON.parse(readFileSync(
      join(productRoot, "docs/contracts/UNIVERSAL_COMPATIBILITY_INVENTORY.json"),
      "utf8",
    )) as { commands: Record<string, string[]> };
    const known = new Set(Object.values(inventory.commands).flat());
    expect(known.size).toBeGreaterThan(20);

    const recipes = await onboard(home, project);
    expect(recipes.length).toBeGreaterThan(40);
    for (const recipe of recipes) {
      const verb = recipe.argvTemplate[1]!;
      expect(known.has(verb), `${recipe.id} runs \`tasq ${verb}\`, which is not a command`).toBe(true);
    }
  });

  test("every declared parameter appears in the argv it is declared for", async () => {
    // A parameter nobody substitutes is a question asked for nothing; a
    // placeholder with no parameter is a vector an agent cannot complete.
    const { home, project } = sandbox();
    for (const recipe of await onboard(home, project)) {
      const placeholders = recipe.argvTemplate
        .flatMap((token) => [...token.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!));
      const declared = recipe.parameters.map((parameter) => parameter.name);
      expect(new Set(placeholders), recipe.id).toEqual(new Set(declared));
    }
  });

  test("the decomposition and relation recipes run, and do what they say", async () => {
    // ADR-024 makes the CLI the default door for a local agent. These four
    // existed on MCP and not here, so choosing the default meant losing them.
    const { home, project } = sandbox();
    const recipes = await onboard(home, project);
    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    for (const id of ["commitment.decompose", "commitment.tree", "relation.add", "relation.end"]) {
      expect(byId.has(id), `${id} is missing from the recipe set`).toBe(true);
    }

    const parent = JSON.parse((await execute(home, project, byId.get("commitment.propose")!, {
      title: "Ship the thing",
    })).stdout);
    const child = JSON.parse((await execute(home, project, byId.get("commitment.decompose")!, {
      title: "Draft the notes",
      parentCommitmentId: parent.id,
    })).stdout);
    // Decomposition is a column, not an edge (ADR-023).
    expect(child.parentTaskId).toBe(parent.id);

    const tree = JSON.parse((await execute(home, project, byId.get("commitment.tree")!, {
      commitmentId: parent.id,
    })).stdout);
    expect(tree.map((task: { id: string }) => task.id)).toEqual([parent.id, child.id]);

    const other = JSON.parse((await execute(home, project, byId.get("commitment.propose")!, {
      title: "Cut the release",
    })).stdout);
    const edge = JSON.parse((await execute(home, project, byId.get("relation.add")!, {
      commitmentId: other.id,
      otherCommitmentId: parent.id,
      relationType: "blocks",
    })).stdout);
    expect(edge).toMatchObject({ fromTaskId: other.id, toTaskId: parent.id, type: "blocks" });

    // Read where the recipe set says relations are read - and under the name it
    // says they appear under. `--type blocks` is written, `depends_on` is read:
    // the CLI flag and the kernel vocabulary are different words for one edge,
    // which is exactly the kind of thing a recipe description has to carry.
    const inspected = JSON.parse((await execute(home, project, byId.get("commitment.inspect")!, {
      commitmentId: other.id,
    })).stdout);
    expect(inspected.relations).toContainEqual(
      expect.objectContaining({ relationType: "depends_on", endedAt: null }),
    );

    const ended = JSON.parse((await execute(home, project, byId.get("relation.end")!, {
      commitmentId: other.id,
      otherCommitmentId: parent.id,
      relationType: "blocks",
    })).stdout);
    expect(ended).toMatchObject({ removed: true });
    // Ending a relation must not touch either commitment.
    const after = JSON.parse((await execute(home, project, byId.get("commitment.inspect")!, {
      commitmentId: other.id,
    })).stdout);
    expect(after.relations.filter((edge: { relationType: string; endedAt: number | null }) =>
      edge.relationType === "depends_on" && edge.endedAt === null)).toHaveLength(0);
    expect(after.commitment).toMatchObject({ status: "open" });
  });

  test("the decomposition journey only names recipes that exist", async () => {
    const { home, project } = sandbox();
    const result = await ok(home, project, [
      cli, "onboard", "--space", "recipes/test", "--actor", "agent-a", "--json",
    ]);
    const parsed = JSON.parse(result.stdout);
    const ids = new Set((parsed.recipes as Recipe[]).map((recipe) => recipe.id));
    for (const journey of parsed.guide.journeys as Array<{ id: string; recipeIds: string[] }>) {
      for (const id of journey.recipeIds) {
        expect(ids.has(id), `journey ${journey.id} names ${id}`).toBe(true);
      }
    }
  });
});
