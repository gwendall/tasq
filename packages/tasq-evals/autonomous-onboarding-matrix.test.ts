/** TQ-314 — hermetic Level-A/B zero-integrator onboarding matrix. */

import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(120_000);

const here = dirname(fileURLToPath(import.meta.url));
const product = join(here, "..", "..");
const fixtures = join(here, "fixtures");
const roots: string[] = [];
let binDir = "";
let cli = "";

type Run = { exitCode: number; stdout: string; stderr: string };

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function spawn(
  argv: string[],
  options: { home?: string; cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): Promise<Run> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.home ? { HOME: options.home, TASQ_DB_URL: "" } : {}),
      ...options.env,
    },
    stdin: options.stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function ok(argv: string[], options: Parameters<typeof spawn>[1] = {}): Promise<Run> {
  const result = await spawn(argv, options);
  expect(result.exitCode, `${argv.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
  return result;
}

function pointer(space: string, actor: string, capabilities?: string): string[] {
  return [
    cli, "onboard", "--space", space, "--actor", actor,
    ...(capabilities ? ["--capabilities", capabilities] : []), "--json",
  ];
}

function request(space: string, actor: string, resourceKey: string, idempotencyKey: string) {
  return {
    pointerArgv: pointer(space, actor),
    actions: [{
      recipeId: "resource.acquire",
      replacements: {
        "{resourceKey}": resourceKey,
        "{duration}": "30m",
        "{idempotencyKey}": idempotencyKey,
      },
    }],
  };
}

async function externalClient(
  runtime: "python" | "js" | "shell",
  home: string,
  body: unknown,
  cwd?: string,
): Promise<Run> {
  const argv = runtime === "python"
    ? ["python3", join(fixtures, "discovery-recipe-client.py")]
    : runtime === "js"
      ? ["node", join(fixtures, "discovery-recipe-client.mjs")]
      : ["sh", join(fixtures, "discovery-recipe-client.sh")];
  return spawn(argv, { home, cwd, stdin: JSON.stringify(body) });
}

beforeAll(async () => {
  binDir = temporary("tasq-tq314-bin-");
  cli = join(binDir, "tasq");
  // Model package-manager bin links: clients see only stable executable names,
  // while dependency resolution remains anchored at the installed package.
  symlinkSync(join(product, "packages/tasq-cli/src/index.ts"), cli);
});

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("TQ-314 Level A — cold package-independent clients", () => {
  test("warm pointer is idempotent and completes in under one second", async () => {
    const home = temporary("tasq-tq314-latency-");
    await ok(pointer("latency", "cold"), { home });
    const started = Bun.nanoseconds();
    const joined = JSON.parse((await ok(pointer("latency", "cold"), { home })).stdout);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
    expect(joined.disposition).toBe("joined");
    expect(elapsedMs, `warm pointer took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(1_000);
  });

  test("shell, Python and JS bootstrap from one pointer and execute only discovered recipes", async () => {
    const cases = [
      ["shell", "tcp:2567", "shell-key"],
      ["python", "déploiement/équipe-東京", "python-key"],
      ["js", "x".repeat(512), "js-key"],
    ] as const;
    for (const [runtime, key, retryKey] of cases) {
      const home = temporary(`tasq-tq314-${runtime}-`);
      const result = await externalClient(runtime, home, request(`matrix/${runtime}`, `${runtime}:cold`, key, retryKey));
      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      const operation = runtime === "shell" ? output : output.results[0].stdout;
      expect(operation).toMatchObject({
        contractVersion: "tasq.resource-operation.v1",
        disposition: "acquired",
        lease: { workspaceId: `matrix/${runtime}`, resourceKey: key, holderActor: `${runtime}:cold` },
      });
      expect(result.stderr).toBe("");
    }
  });

  test("covers absent, existing, stale, corrupt, inaccessible and unsafe local state", async () => {
    const absent = temporary("tasq-tq314-absent-");
    expect(existsSync(join(absent, ".tasq"))).toBe(false);
    expect(JSON.parse((await ok(pointer("state/space", "alpha"), { home: absent })).stdout).disposition).toBe("created");
    expect(JSON.parse((await ok(pointer("state/space", "beta"), { home: absent })).stdout).disposition).toBe("joined");

    const stale = temporary("tasq-tq314-stale-");
    mkdirSync(join(stale, ".tasq"), { mode: 0o700 });
    writeFileSync(join(stale, ".tasq", "config.json"), JSON.stringify({
      dbPath: join(stale, ".tasq", "db.sqlite"),
      tenantId: "unrelated/default",
      defaultActor: "unrelated-actor",
      eventJournalPath: join(stale, ".tasq", "events.jsonl"),
    }), { mode: 0o600 });
    const explicit = JSON.parse((await ok(pointer("state/explicit", "explicit-actor"), { home: stale })).stdout);
    expect(explicit).toMatchObject({ space: { workspaceId: "state/explicit" }, actor: { alias: "explicit-actor" } });

    const corruptConfig = temporary("tasq-tq314-corrupt-config-");
    mkdirSync(join(corruptConfig, ".tasq"), { mode: 0o700 });
    writeFileSync(join(corruptConfig, ".tasq", "config.json"), "{truncated", { mode: 0o600 });
    const badConfig = await spawn(pointer("state/config", "alpha"), { home: corruptConfig });
    expect(badConfig).toMatchObject({ exitCode: 4, stderr: "" });
    expect(JSON.parse(badConfig.stdout)).toMatchObject({ code: "config_error", retryable: false });

    const corruptDb = temporary("tasq-tq314-corrupt-db-");
    mkdirSync(join(corruptDb, ".tasq"), { mode: 0o700 });
    writeFileSync(join(corruptDb, ".tasq", "db.sqlite"), "not a sqlite database", { mode: 0o600 });
    const badDb = await spawn(pointer("state/database", "alpha"), { home: corruptDb });
    expect(badDb).toMatchObject({ exitCode: 3, stderr: "" });
    expect(JSON.parse(badDb.stdout)).toMatchObject({ code: "storage_error" });

    const unsafe = temporary("tasq-tq314-unsafe-");
    mkdirSync(join(unsafe, ".tasq"), { mode: 0o777 });
    chmodSync(join(unsafe, ".tasq"), 0o777);
    const unsafeResult = await spawn(pointer("state/unsafe", "alpha"), { home: unsafe });
    expect(unsafeResult).toMatchObject({ exitCode: 3, stderr: "" });
    const unsafeProblem = JSON.parse(unsafeResult.stdout);
    expect(unsafeProblem).toMatchObject({ code: "storage_error" });
    expect(unsafeProblem.nextActions[0].argv.slice(1)).toEqual([
      "doctor", "--fix-permissions", "--json",
    ]);

    const inaccessible = temporary("tasq-tq314-readonly-");
    chmodSync(inaccessible, 0o500);
    try {
      const denied = await spawn(pointer("state/readonly", "alpha"), { home: inaccessible });
      expect(denied.exitCode).not.toBe(0);
      expect(JSON.parse(denied.stdout)).toMatchObject({ status: "error" });
    } finally {
      chmodSync(inaccessible, 0o700);
    }
  });

  test("capability guidance is honest locally and enforced by raw MCP registration", async () => {
    const home = temporary("tasq-tq314-capabilities-");
    const read = JSON.parse((await ok(pointer("caps", "reader", "read"), { home })).stdout);
    expect(read.recipes.every((recipe: any) => recipe.requiredCapability === "read" && recipe.mutates === false)).toBe(true);
    expect(read.authority).toMatchObject({ capabilityEnforcement: "none", effectAuthority: "not_granted" });
    const coordinate = JSON.parse((await ok(pointer("caps", "coordinator", "read,coordinate"), { home })).stdout);
    expect(coordinate.recipes.some((recipe: any) => recipe.id === "resource.acquire")).toBe(true);
    expect(coordinate.recipes.some((recipe: any) => recipe.requiredCapability === "propose")).toBe(false);
    const effect = await spawn(pointer("caps", "effect-seeker", "effect"), { home });
    expect(effect.exitCode).toBe(2);

    const rawClient = join(fixtures, "raw-mcp-client.mjs");
    const transportArgv = (document: any) => {
      const recipe = document.recipes.find((candidate: any) => candidate.id === "transport.mcp.stdio");
      expect(recipe, "bootstrap must advertise an executable MCP transport").toBeDefined();
      return recipe.argvTemplate;
    };
    const baseEnv = { HOME: home, TASQ_DB_URL: "" };
    const readOnly = await ok(["node", rawClient], {
      stdin: JSON.stringify({ serverArgv: transportArgv(read), serverEnv: baseEnv, calls: [] }),
    });
    const readTools = JSON.parse(readOnly.stdout).tools;
    expect(readTools.length).toBeGreaterThan(0);
    expect(readTools.every((tool: any) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(readTools.some((tool: any) => tool.name === "tasq_resource_acquire")).toBe(false);

    const mcpBootstrap = JSON.parse((await ok(pointer("caps", "mcp:cold", "read,coordinate"), { home })).stdout);
    const coordinated = await ok(["node", rawClient], {
      stdin: JSON.stringify({
        serverArgv: transportArgv(mcpBootstrap),
        serverEnv: baseEnv,
        calls: [{ name: "tasq_resource_acquire", arguments: {
          resourceKey: "mcp:slot", leaseMs: 30_000, idempotencyKey: "raw-mcp-acquire-1",
        } }],
      }),
    });
    const mcpOutput = JSON.parse(coordinated.stdout);
    expect(mcpOutput.tools.some((tool: any) => tool.name === "tasq_resource_acquire")).toBe(true);
    expect(mcpOutput.calls[0].structuredContent).toMatchObject({
      contractVersion: "tasq.resource-operation.v1",
      lease: { workspaceId: "caps", resourceKey: "mcp:slot", holderActor: "mcp:cold" },
    });
    const loserBootstrap = JSON.parse((await ok(pointer("caps", "mcp:loser", "read,coordinate"), { home })).stdout);
    const contended = await ok(["node", rawClient], {
      stdin: JSON.stringify({
        serverArgv: transportArgv(loserBootstrap),
        serverEnv: baseEnv,
        calls: [{ name: "tasq_resource_acquire", arguments: {
          resourceKey: "mcp:slot", leaseMs: 30_000, idempotencyKey: "raw-mcp-loser-1",
        } }],
      }),
    });
    expect(JSON.parse(contended.stdout).calls[0].structuredContent).toMatchObject({
      contractVersion: "tasq.resource-problem.v1",
      code: "contended",
      retryable: true,
      currentLease: { lease: { resourceKey: "mcp:slot", holderActor: "mcp:cold", fence: 1 } },
    });
  });
});

describe("TQ-314 Level B — contention, loss, kill and controlled time", () => {
  test("elects exactly one winner across ten cold clients in separate process directories", async () => {
    const home = temporary("tasq-tq314-race-");
    const runs = await Promise.all(Array.from({ length: 10 }, (_, index) => {
      const cwd = temporary(`tasq-tq314-worktree-${index}-`);
      return externalClient("python", home, request("race/ten", `actor:${index}`, "deploy:production", `race-${index}`), cwd);
    }));
    const operations = runs.map((run) => {
      expect(run.exitCode, run.stderr).toBe(0);
      const session = JSON.parse(run.stdout);
      expect(session.bootstrap.exitCode, JSON.stringify(session.bootstrap)).toBe(0);
      expect(session.results, JSON.stringify(session)).toHaveLength(1);
      return session.results[0];
    });
    expect(operations.filter((operation) => operation.exitCode === 0)).toHaveLength(1);
    expect(operations.filter((operation) => operation.exitCode === 1)).toHaveLength(9);
    for (const loser of operations.filter((operation) => operation.exitCode === 1)) {
      expect(loser.stderr).toBe("");
      expect(loser.stdout).toMatchObject({
        contractVersion: "tasq.resource-problem.v1",
        code: "contended",
        retryable: true,
        currentLease: { lease: { resourceKey: "deploy:production", fence: 1 } },
      });
      expect(loser.stdout.nextActions.map((action: any) => action.kind)).toEqual([
        "inspect", "wait_until", "retry", "choose_alternative",
      ]);
    }
  });

  test("recovers a lost committed response by exact cross-runtime retry", async () => {
    const home = temporary("tasq-tq314-lost-response-");
    const body = request("loss", "same-actor", "shared:stash", "stable-request-1");
    const committedButLost = await externalClient("js", home, body);
    expect(committedButLost.exitCode).toBe(0); // The harness deliberately discards its payload below.
    const retry = JSON.parse((await externalClient("python", home, body)).stdout).results[0];
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout).toMatchObject({
      contractVersion: "tasq.resource-operation.v1",
      lease: { resourceKey: "shared:stash", holderActor: "same-actor", fence: 1 },
    });
    const world = JSON.parse((await ok([
      cli, "resource", "list", "--tenant", "loss", "--actor", "auditor", "--json",
    ], { home })).stdout);
    expect(world.leases).toHaveLength(1);
  });

  test("a killed holder expires exactly on injected authority time and its fence stays dead", async () => {
    const killedHome = temporary("tasq-tq314-real-kill-");
    const holder = Bun.spawn(["node", join(fixtures, "discovery-recipe-client.mjs")], {
      env: { ...process.env, HOME: killedHome, TASQ_DB_URL: "" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    holder.stdin.write(JSON.stringify({
      ...request("killed", "doomed-holder", "deploy:killed", "doomed-1"),
      holdAfterResult: true,
    }));
    holder.stdin.end();
    const reader = holder.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      line += new TextDecoder().decode(chunk.value);
    }
    const killedSession = JSON.parse(line.trim());
    expect(killedSession.results[0].stdout).toMatchObject({
      disposition: "acquired", lease: { resourceKey: "deploy:killed", holderActor: "doomed-holder" },
    });
    holder.kill("SIGKILL");
    await holder.exited;
    const stillDurable = JSON.parse((await ok([
      cli, "resource", "get", "deploy:killed", "--tenant", "killed", "--actor", "auditor", "--json",
    ], { home: killedHome })).stdout);
    expect(stillDurable).toMatchObject({ status: "active", lease: { holderActor: "doomed-holder" } });

    const home = temporary("tasq-tq314-kill-clock-");
    const driver = join(fixtures, "injected-clock-cli.ts");
    const runAt = (at: number, args: string[]) => spawn(["bun", "run", driver, ...args], {
      home, env: { TASQ_EVAL_CLOCK_MS: String(at) },
    });
    await ok(["bun", "run", driver, ...pointer("clocked", "holder").slice(1)], {
      home, env: { TASQ_EVAL_CLOCK_MS: "10000" },
    });
    const acquired = JSON.parse((await runAt(20_000, [
      "resource", "acquire", "tcp:8080", "--for", "1s", "--idempotency-key", "holder-1",
      "--tenant", "clocked", "--actor", "holder", "--json",
    ])).stdout);
    expect(acquired.lease).toMatchObject({ acquiredAt: 20_000, expiresAt: 21_000, fence: 1 });

    const before = await runAt(20_999, [
      "resource", "verify", "tcp:8080", "--lease", acquired.lease.id, "--fence", "1",
      "--tenant", "clocked", "--actor", "holder", "--json",
    ]);
    expect(before.exitCode).toBe(0);
    const boundary = await runAt(21_000, [
      "resource", "verify", "tcp:8080", "--lease", acquired.lease.id, "--fence", "1",
      "--tenant", "clocked", "--actor", "holder", "--json",
    ]);
    expect(boundary.exitCode).toBe(1);
    expect(JSON.parse(boundary.stdout)).toMatchObject({ code: "expired" });
    const reclaimed = JSON.parse((await runAt(21_000, [
      "resource", "acquire", "tcp:8080", "--for", "1s", "--idempotency-key", "replacement-1",
      "--tenant", "clocked", "--actor", "replacement", "--json",
    ])).stdout);
    expect(reclaimed).toMatchObject({ disposition: "reclaimed", lease: { fence: 2, acquiredAt: 21_000 } });
    const stale = await runAt(21_001, [
      "resource", "verify", "tcp:8080", "--lease", acquired.lease.id, "--fence", "1",
      "--tenant", "clocked", "--actor", "holder", "--json",
    ]);
    expect(JSON.parse(stale.stdout)).toMatchObject({ code: "stale_fence", currentLease: { lease: { fence: 2 } } });
    const rewind = await runAt(20_500, [
      "resource", "list", "--tenant", "clocked", "--actor", "auditor", "--json",
    ]);
    expect(rewind.exitCode).toBe(1);
    expect(JSON.parse(rewind.stdout)).toMatchObject({ code: "clock_regression" });
  });

  test("clients contain no product imports, provider vocabulary, repository reads or hidden wall clocks", () => {
    for (const name of ["discovery-recipe-client.py", "discovery-recipe-client.mjs", "discovery-recipe-client.sh", "raw-mcp-client.mjs"]) {
      const source = readFileSync(join(fixtures, name), "utf8").toLowerCase();
      for (const forbidden of ["@kami/", "gmail", "mercury", "github", "_life", "date.now", "datetime.now", "products/tasq"]) {
        expect(source, `${name} contains forbidden knowledge: ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect((statSync(cli).mode & 0o111)).not.toBe(0);
  });
});
