/** TQ-316 — release-artifact cold-start portability and rendezvous matrix. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

setDefaultTimeout(120_000);

const here = dirname(fileURLToPath(import.meta.url));
const product = join(here, "..", "..");
const fixtures = join(here, "fixtures");
const roots: string[] = [];
let root = "";
let release = "";
let cli = "";
let binDir = "";
let jq = "";

type Run = { exitCode: number; stdout: string; stderr: string };

type MatrixValue = string;
type MatrixDimensions = Readonly<Record<string, readonly MatrixValue[]>>;
type MatrixCase = Readonly<Record<string, MatrixValue>>;

/**
 * Deterministic greedy all-pairs generator. The support claim is intentionally
 * pairwise rather than the impossible full Cartesian product; safety-critical
 * crash, authority and corruption cases remain explicit below.
 */
function pairwiseCases(dimensions: MatrixDimensions): MatrixCase[] {
  const entries = Object.entries(dimensions);
  const candidates: MatrixCase[] = [];
  const visit = (index: number, current: Record<string, string>) => {
    if (index === entries.length) {
      candidates.push({ ...current });
      return;
    }
    const [name, values] = entries[index]!;
    for (const value of values) {
      current[name] = value;
      visit(index + 1, current);
    }
  };
  visit(0, {});

  const pairKeys = (candidate: MatrixCase): string[] => {
    const pairs: string[] = [];
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const leftName = entries[left]![0];
        const rightName = entries[right]![0];
        pairs.push(`${leftName}=${candidate[leftName]}|${rightName}=${candidate[rightName]}`);
      }
    }
    return pairs;
  };

  const uncovered = new Set(candidates.flatMap(pairKeys));
  const selected: MatrixCase[] = [];
  while (uncovered.size > 0) {
    let best: MatrixCase | undefined;
    let bestCoverage = -1;
    for (const candidate of candidates) {
      const coverage = pairKeys(candidate).filter((key) => uncovered.has(key)).length;
      if (coverage > bestCoverage) {
        best = candidate;
        bestCoverage = coverage;
      }
    }
    if (!best || bestCoverage <= 0) throw new Error("pairwise matrix stopped making progress");
    selected.push(best);
    for (const key of pairKeys(best)) uncovered.delete(key);
  }
  return selected;
}

function sha256(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
}

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function minimalEnv(home: string, additions: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    TASQ_HOME: join(home, ".tasq state"),
    // POSIX+jq is an explicitly declared client profile. Preserve the actual
    // installed jq directory even when the platform keeps it outside
    // /usr/bin (GitHub's macOS image uses /usr/local/bin).
    PATH: `${binDir}:${dirname(process.execPath)}:${dirname(jq)}:/usr/bin:/bin`,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    ...additions,
  };
}

async function run(
  argv: string[],
  options: { home: string; cwd?: string; env?: Record<string, string>; stdin?: string },
): Promise<Run> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? root,
    env: minimalEnv(options.home, options.env),
    stdin: options.stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function pointer(executable: string, space: string, actor: string, capabilities?: string): string[] {
  return [
    executable,
    "onboard",
    "--space",
    space,
    "--actor",
    actor,
    ...(capabilities ? ["--capabilities", capabilities] : []),
    "--json",
  ];
}

function request(pointerArgv: string[], resourceKey: string, idempotencyKey: string) {
  return {
    pointerArgv,
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

async function expectJsonSuccess(argv: string[], options: Parameters<typeof run>[1]): Promise<any> {
  const result = await run(argv, options);
  expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

beforeAll(async () => {
  jq = Bun.which("jq") ?? "";
  expect(jq, "the POSIX client profile requires an installed jq executable").not.toBe("");
  root = temporary("tasq tq316 release root é-");
  release = join(root, "published artifact");
  const build = Bun.spawn([
    "bun",
    "run",
    join(product, "packages/tasq-cli/scripts/build.ts"),
    "--outdir",
    release,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
  binDir = join(root, "only stable bin");
  mkdirSync(binDir, { recursive: true });
  cli = join(binDir, "tasq");
  symlinkSync(join(release, "index.js"), cli);
});

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("TQ-316 release artifact across cold configurations", () => {
  test("boots outside the repository with a scrubbed environment and bounded path-free output", async () => {
    const home = join(root, "home with spaces é");
    const cwd = join(root, "worktree 東京 (cold)");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    // A cwd-local fake config must never become implicit coordination state.
    mkdirSync(join(cwd, ".tasq"));
    writeFileSync(join(cwd, ".tasq", "config.json"), "{not-json");

    const output = await expectJsonSuccess(pointer("tasq", "portable/clean", "agent étrange"), {
      home,
      cwd,
      env: { TASQ_ACTOR: "ambient-spoof-must-not-win" },
    });
    expect(output).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      disposition: "created",
      space: { workspaceId: "portable/clean" },
      actor: { alias: "agent étrange", authentication: "local_process_self_asserted" },
      transportBoundary: "local_process",
    });
    expect(output.warnings.join(" ")).toContain("same Tasq store or transport");
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(64 * 1024);
    const discovery = JSON.stringify(output.discovery);
    for (const secretPath of [home, cwd, root, release]) expect(discovery).not.toContain(secretPath);
    expect(new Set(output.recipes.map((recipe: any) => recipe.argvTemplate[0])))
      .toEqual(new Set([realpathSync(join(release, "index.js"))]));
    const recipeArguments = JSON.stringify(output.recipes.map((recipe: any) => recipe.argvTemplate.slice(1)));
    for (const secretPath of [home, cwd, root, release]) expect(recipeArguments).not.toContain(secretPath);
    expect(existsSync(join(home, ".tasq state", "db.sqlite"))).toBe(true);
    expect(readFileSync(join(cwd, ".tasq", "config.json"), "utf8")).toBe("{not-json");
  });

  test("Python, Node and POSIX+jq clients execute argv recipes across invocation and locale variants", async () => {
    const marker = join(root, "shell-injection-must-not-exist");
    const dangerousKey = `slot/é;$(touch ${marker})`;
    const cases = [
      {
        name: "python-absolute-c",
        interpreter: Bun.which("python3")!,
        fixture: "discovery-recipe-client.py",
        executable: cli,
        locale: "C",
        path: `${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      {
        name: "node-path-utf8",
        interpreter: Bun.which("node")!,
        fixture: "discovery-recipe-client.mjs",
        executable: "tasq",
        locale: "en_US.UTF-8",
        path: undefined,
      },
      {
        name: "shell-jq-path",
        interpreter: "/bin/sh",
        fixture: "discovery-recipe-client.sh",
        executable: "tasq",
        locale: "C",
        path: undefined,
      },
    ];
    for (const item of cases) {
      const home = join(root, `client home ${item.name}`);
      const cwd = join(root, `client cwd ${item.name}`);
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const result = await run([item.interpreter, join(fixtures, item.fixture)], {
        home,
        cwd,
        env: {
          LANG: item.locale,
          LC_ALL: item.locale,
          ...(item.path ? { PATH: item.path } : {}),
        },
        stdin: JSON.stringify(request(
          pointer(item.executable, `clients/${item.name}`, `actor ${item.name}`),
          dangerousKey,
          `request-${item.name}`,
        )),
      });
      expect(result.exitCode, `${item.name}: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      const session = JSON.parse(result.stdout);
      const operation = item.name === "shell-jq-path" ? session : session.results[0].stdout;
      expect(operation).toMatchObject({
        contractVersion: "tasq.resource-operation.v1",
        disposition: "acquired",
        lease: { resourceKey: dangerousKey, holderActor: `actor ${item.name}` },
      });
    }
    expect(existsSync(marker), "a recipe value was interpreted as shell syntax").toBe(false);
  });

  test("Python, Node and POSIX+jq cold clients consume the bounded context recipe unchanged", async () => {
    const cases = [
      { name: "python-context", interpreter: Bun.which("python3")!, fixture: "discovery-recipe-client.py" },
      { name: "node-context", interpreter: Bun.which("node")!, fixture: "discovery-recipe-client.mjs" },
      { name: "shell-context", interpreter: "/bin/sh", fixture: "discovery-recipe-client.sh" },
    ];
    for (const item of cases) {
      const home = join(root, `context home ${item.name}`);
      const cwd = join(root, `context cwd ${item.name}`);
      const space = `context/${item.name}`;
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      await expectJsonSuccess(pointer(cli, space, "seed"), { home, cwd });
      await expectJsonSuccess([
        cli, "add", `Shared work ${item.name}`,
        "--tenant", space, "--actor", "seed", "--json",
      ], { home, cwd });

      const result = await run([item.interpreter, join(fixtures, item.fixture)], {
        home,
        cwd,
        stdin: JSON.stringify({
          pointerArgv: pointer(cli, space, `cold ${item.name}`),
          actions: [{ recipeId: "context.read", replacements: {} }],
        }),
      });
      expect(result.exitCode, `${item.name}: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      const session = JSON.parse(result.stdout);
      const packet = item.name === "shell-context" ? session : session.results[0].stdout;
      expect(packet).toMatchObject({
        contractVersion: "tasq.context-packet.v1",
        workspaceId: space,
        requestingActor: `cold ${item.name}`,
        selection: { eligibleRecords: 1, selectedRecords: 1 },
        budget: { maxRecords: 20, maxTokens: 8_192, hardLimitSatisfied: true },
      });
      expect(packet.items[0].commitment.title).toBe(`Shared work ${item.name}`);
      expect(packet.budget.usedTokens).toBeLessThanOrEqual(8_192);
    }
  });

  test("the release manifest accounts for every migration and the native binding", async () => {
    const manifest = JSON.parse(readFileSync(join(release, "artifact.json"), "utf8"));
    expect(manifest.contractVersion).toBe("tasq.cli-artifact.v1");
    expect(manifest.nativePackages).toHaveLength(1);
    const native = manifest.nativePackages[0];
    const platformArch = `${process.platform}-${process.arch}`;
    expect(
      native.target === platformArch || native.target.startsWith(`${platformArch}-`),
      `native target ${native.target} does not match runtime ${platformArch}`,
    ).toBe(true);
    expect(native.package).toBe(`@libsql/${native.target}`);
    expect(native.sha256).toBe(sha256(join(
      release, "node_modules", "@libsql", native.target, "index.node",
    )));
    expect(manifest.migrations.at(-1)?.name).toBe("0024_external_context_links.sql");
    for (const migration of manifest.migrations) {
      expect(existsSync(join(release, migration.name)), migration.name).toBe(true);
      expect(migration.sha256).toBe(sha256(join(release, migration.name)));
    }
  });
});

describe("TQ-317 pairwise onboarding certification", () => {
  const dimensions = {
    client: ["python", "node", "shell"],
    invocation: ["absolute", "path"],
    locale: ["c", "utf8"],
    capabilities: ["read", "read-propose", "read-coordinate", "all"],
    initialState: ["absent", "joined", "active"],
    cwd: ["clean", "hostile"],
    actor: ["ascii", "unicode", "max"],
    space: ["ascii", "max"],
  } as const satisfies MatrixDimensions;

  test("a bounded all-pairs matrix executes discovery recipes unchanged", async () => {
    const cases = pairwiseCases(dimensions);
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.length).toBeLessThanOrEqual(40);

    for (const [index, item] of cases.entries()) {
      const label = `case-${String(index).padStart(2, "0")}`;
      const home = join(root, `cert home ${label} é`);
      const cwd = join(root, `cert cwd ${label} 東京`);
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      if (item.cwd === "hostile") {
        mkdirSync(join(cwd, ".tasq"));
        writeFileSync(join(cwd, ".tasq", "config.json"), "{poisoned-cwd-config");
      }

      const space = item.space === "max" ? `s${"x".repeat(199)}` : `cert/${label}`;
      const actor = item.actor === "max"
        ? `a${"x".repeat(199)}`
        : item.actor === "unicode" ? `agent étrange 東京 ${label}` : `agent-${label}`;
      const capabilities = item.capabilities === "all"
        ? "read,propose,coordinate"
        : item.capabilities === "read-propose" ? "read,propose"
          : item.capabilities === "read-coordinate" ? "read,coordinate" : item.capabilities;
      const executable = item.invocation === "absolute" ? cli : "tasq";
      const locale = item.locale === "utf8" ? "en_US.UTF-8" : "C";

      if (item.initialState !== "absent") {
        await expectJsonSuccess(pointer(cli, space, "seed", "read,propose,coordinate"), { home, cwd });
      }
      if (item.initialState === "active") {
        await expectJsonSuccess([
          cli, "add", `Existing shared work ${label}`,
          "--tenant", space, "--actor", "seed", "--json",
        ], { home, cwd });
      }

      const action = item.capabilities === "read" || item.capabilities === "all"
        ? { recipeId: "context.read", replacements: {} }
        : item.capabilities === "read-propose"
          ? {
              recipeId: "commitment.propose",
              replacements: { "{title}": `Proposed outcome ${label}` },
            }
          : {
              recipeId: "resource.acquire",
              replacements: {
                "{resourceKey}": `opaque/${label};not-shell`,
                "{duration}": "30m",
                "{idempotencyKey}": `cert-${label}`,
              },
            };
      const fixture = item.client === "python"
        ? "discovery-recipe-client.py"
        : item.client === "node" ? "discovery-recipe-client.mjs" : "discovery-recipe-client.sh";
      const interpreter = item.client === "python"
        ? Bun.which("python3")!
        : item.client === "node" ? Bun.which("node")! : "/bin/sh";
      const result = await run([interpreter, join(fixtures, fixture)], {
        home,
        cwd,
        env: {
          LANG: locale,
          LC_ALL: locale,
          TASQ_ACTOR: "ambient-actor-must-not-win",
          TASQ_TENANT: "ambient-space-must-not-win",
        },
        stdin: JSON.stringify({ pointerArgv: pointer(executable, space, actor, capabilities), actions: [action] }),
      });
      expect(result.exitCode, `${label} ${JSON.stringify(item)}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      const session = JSON.parse(result.stdout);
      if (item.client !== "shell") {
        expect(
          session.bootstrap?.exitCode,
          `${label} bootstrap ${JSON.stringify(item)}: ${JSON.stringify(session.bootstrap)}`,
        ).toBe(0);
        expect(session.results, `${label} results: ${JSON.stringify(session)}`).toHaveLength(1);
      }
      const output = item.client === "shell" ? session : session.results[0].stdout;
      if (action.recipeId === "context.read") {
        expect(output).toMatchObject({
          contractVersion: "tasq.context-packet.v1",
          workspaceId: space,
          requestingActor: actor,
        });
        expect(output.budget.hardLimitSatisfied).toBe(true);
      } else if (action.recipeId === "commitment.propose") {
        expect(output).toMatchObject({ tenantId: space, title: `Proposed outcome ${label}` });
      } else {
        expect(output).toMatchObject({
          contractVersion: "tasq.resource-operation.v1",
          disposition: "acquired",
          lease: { workspaceId: space, holderActor: actor, resourceKey: `opaque/${label};not-shell` },
        });
      }
    }
  });

  test("the built release fails closed on corrupt stores and unsafe permissions", async () => {
    const corruptConfigHome = join(root, "cert corrupt config");
    mkdirSync(join(corruptConfigHome, ".tasq state"), { recursive: true, mode: 0o700 });
    writeFileSync(join(corruptConfigHome, ".tasq state", "config.json"), "{truncated", { mode: 0o600 });
    const corruptConfig = await run(pointer(cli, "cert/corrupt-config", "agent"), { home: corruptConfigHome });
    expect(corruptConfig).toMatchObject({ exitCode: 4, stderr: "" });
    expect(JSON.parse(corruptConfig.stdout)).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap-problem.v1",
      code: "config_error",
      retryable: false,
    });

    const corruptDbHome = join(root, "cert corrupt db");
    mkdirSync(join(corruptDbHome, ".tasq state"), { recursive: true, mode: 0o700 });
    writeFileSync(join(corruptDbHome, ".tasq state", "db.sqlite"), "not sqlite", { mode: 0o600 });
    const corruptDb = await run(pointer(cli, "cert/corrupt-db", "agent"), { home: corruptDbHome });
    expect(corruptDb).toMatchObject({ exitCode: 3, stderr: "" });
    expect(JSON.parse(corruptDb.stdout)).toMatchObject({ code: "storage_error" });

    const unsafeHome = join(root, "cert unsafe home");
    mkdirSync(join(unsafeHome, ".tasq state"), { recursive: true, mode: 0o777 });
    chmodSync(join(unsafeHome, ".tasq state"), 0o777);
    const unsafe = await run(pointer(cli, "cert/unsafe", "agent"), { home: unsafeHome });
    expect(unsafe).toMatchObject({ exitCode: 3, stderr: "" });
    expect(JSON.parse(unsafe.stdout)).toMatchObject({
      code: "storage_error",
      nextActions: [{ argv: [realpathSync(join(release, "index.js")), "doctor", "--fix-permissions", "--json"] }],
    });
  });

  test("every independent client rejects an unknown or truncated bootstrap before executing a recipe", async () => {
    const home = join(root, "cert malformed client home");
    mkdirSync(home, { recursive: true });
    const invalidPayloads = [
      JSON.stringify({ contractVersion: "tasq.autonomous-bootstrap.v999", recipes: [] }),
      '{"contractVersion":"tasq.autonomous-bootstrap.v1","recipes":',
    ];
    const clients = [
      { interpreter: Bun.which("python3")!, fixture: "discovery-recipe-client.py" },
      { interpreter: Bun.which("node")!, fixture: "discovery-recipe-client.mjs" },
      { interpreter: "/bin/sh", fixture: "discovery-recipe-client.sh" },
    ];
    for (const payload of invalidPayloads) {
      for (const client of clients) {
        const result = await run([client.interpreter, join(fixtures, client.fixture)], {
          home,
          stdin: JSON.stringify({
            pointerArgv: ["/usr/bin/printf", "%s", payload],
            actions: [{ recipeId: "context.read", replacements: {} }],
          }),
        });
        expect(result.exitCode, `${client.fixture} accepted ${payload}`).not.toBe(0);
      }
    }
  });

  test("a raw package-independent MCP client continues from the discovered transport", async () => {
    const home = join(root, "cert raw mcp home");
    const cwd = join(root, "cert raw mcp cwd");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    await expectJsonSuccess(pointer(cli, "cert/mcp", "seed"), { home, cwd });
    await expectJsonSuccess([
      cli, "add", "MCP-visible shared work",
      "--tenant", "cert/mcp", "--actor", "seed", "--json",
    ], { home, cwd });
    const bootstrap = await expectJsonSuccess(
      pointer(cli, "cert/mcp", "raw:mcp", "read,coordinate"),
      { home, cwd },
    );
    const transport = bootstrap.recipes.find((recipe: any) => recipe.id === "transport.mcp.stdio");
    expect(transport).toBeDefined();
    const raw = await run([Bun.which("node")!, join(fixtures, "raw-mcp-client.mjs")], {
      home,
      cwd,
      stdin: JSON.stringify({
        serverArgv: transport.argvTemplate,
        serverEnv: minimalEnv(home),
        calls: [
          { name: "tasq_context", arguments: { maxRecords: 5, maxTokens: 4_096 } },
          { name: "tasq_resource_acquire", arguments: {
            resourceKey: "robot/arm:left",
            leaseMs: 30_000,
            idempotencyKey: "cert-mcp-acquire-1",
          } },
        ],
      }),
    });
    expect(raw.exitCode, raw.stderr).toBe(0);
    expect(raw.stderr).toBe("");
    const output = JSON.parse(raw.stdout);
    expect(output.calls[0].structuredContent).toMatchObject({
      contractVersion: "tasq.context-packet.v1",
      workspaceId: "cert/mcp",
      requestingActor: "raw:mcp",
      selection: { selectedRecords: 1 },
    });
    expect(output.calls[1].structuredContent).toMatchObject({
      contractVersion: "tasq.resource-operation.v1",
      disposition: "acquired",
      lease: { workspaceId: "cert/mcp", holderActor: "raw:mcp", resourceKey: "robot/arm:left" },
    });
  });
});

describe("TQ-316 rendezvous, isolation and compatibility", () => {
  test("unknown actors meet through store+space, while another space remains isolated", async () => {
    const home = join(root, "shared rendezvous home");
    const cwdA = join(root, "unknown actor A");
    const cwdB = join(root, "unknown actor B");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    const sharedKey = "deploy/shared";
    await expectJsonSuccess(pointer(cli, "rendezvous/shared", "unknown:a"), { home, cwd: cwdA });
    await expectJsonSuccess(pointer("tasq", "rendezvous/shared", "unknown:b"), { home, cwd: cwdB });
    const acquired = await expectJsonSuccess([
      cli, "resource", "acquire", sharedKey, "--for", "30m", "--idempotency-key", "actor-a-1",
      "--tenant", "rendezvous/shared", "--actor", "unknown:a", "--json",
    ], { home, cwd: cwdA });
    expect(acquired.lease.fence).toBe(1);

    const contender = await run([
      "tasq", "resource", "acquire", sharedKey, "--for", "30m", "--idempotency-key", "actor-b-1",
      "--tenant", "rendezvous/shared", "--actor", "unknown:b", "--json",
    ], { home, cwd: cwdB });
    expect(contender.exitCode).toBe(1);
    expect(contender.stderr).toBe("");
    expect(JSON.parse(contender.stdout)).toMatchObject({
      contractVersion: "tasq.resource-problem.v1",
      code: "contended",
      currentLease: { lease: { holderActor: "unknown:a", resourceKey: sharedKey, fence: 1 } },
    });

    await expectJsonSuccess(pointer(cli, "rendezvous/other", "unknown:b"), { home, cwd: cwdB });
    const isolated = await expectJsonSuccess([
      cli, "resource", "acquire", sharedKey, "--for", "30m", "--idempotency-key", "actor-b-other-1",
      "--tenant", "rendezvous/other", "--actor", "unknown:b", "--json",
    ], { home, cwd: cwdB });
    expect(isolated).toMatchObject({ disposition: "acquired", lease: { fence: 1 } });
  });

  test("the local boundary honestly does not bridge isolated stores", async () => {
    const homeA = join(root, "isolated store A");
    const homeB = join(root, "isolated store B");
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });
    const first = await expectJsonSuccess(pointer(cli, "same/name", "actor:a"), { home: homeA });
    const second = await expectJsonSuccess(pointer(cli, "same/name", "actor:b"), { home: homeB });
    expect(first.disposition).toBe("created");
    expect(second.disposition).toBe("created");
    expect(first.space.workspaceId).toBe(second.space.workspaceId);
    expect(first.warnings.join(" ")).toContain("same Tasq store or transport");
  });

  test("a v1 reader ignores additive fields but fails closed on an unknown contract", async () => {
    const home = join(root, "compatibility reader home");
    mkdirSync(home, { recursive: true });
    const bootstrap = await expectJsonSuccess(pointer(cli, "compatibility", "reader"), { home });
    bootstrap.futureTopLevel = { safelyIgnored: true };
    bootstrap.recipes[0].futureRecipeField = "ignored";
    const reader = [Bun.which("node")!, join(fixtures, "bootstrap-version-client.mjs")];
    const compatible = await run(reader, { home, stdin: JSON.stringify(bootstrap) });
    expect(compatible.exitCode).toBe(0);
    expect(JSON.parse(compatible.stdout)).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      space: "compatibility",
      actor: "reader",
    });

    bootstrap.contractVersion = "tasq.autonomous-bootstrap.v999";
    const incompatible = await run(reader, { home, stdin: JSON.stringify(bootstrap) });
    expect(incompatible.exitCode).toBe(1);
    expect(JSON.parse(incompatible.stdout)).toMatchObject({
      status: "error",
      code: "unsupported_contract",
    });

    const truncated = await run(reader, { home, stdin: '{"contractVersion":"tasq.autonomous' });
    expect(truncated.exitCode).toBe(1);
    expect(JSON.parse(truncated.stdout)).toMatchObject({ code: "invalid_json" });

    bootstrap.contractVersion = "tasq.autonomous-bootstrap.v1";
    const malformedCases = [
      { ...bootstrap, recipeCapabilities: undefined },
      { ...bootstrap, recipes: [...bootstrap.recipes, bootstrap.recipes[0]] },
      {
        ...bootstrap,
        recipes: bootstrap.recipes.map((recipe: any, index: number) => index === 0
          ? { ...recipe, version: 2 }
          : recipe),
      },
      {
        ...bootstrap,
        recipes: bootstrap.recipes.map((recipe: any, index: number) => index === 0
          ? { ...recipe, argvTemplate: [...recipe.argvTemplate, "{undeclared}"] }
          : recipe),
      },
    ];
    for (const malformed of malformedCases) {
      const rejected = await run(reader, { home, stdin: JSON.stringify(malformed) });
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stdout)).toMatchObject({ code: "invalid_shape" });
    }
  });

  test("missing rendezvous, identity or read-before-mutate capability fails before creating state", async () => {
    const cases = [
      [cli, "onboard", "--actor", "known", "--json"],
      [cli, "onboard", "--space", "known", "--json"],
      [cli, "onboard", "--space", "unsafe space", "--actor", "known", "--json"],
      [cli, "onboard", "--space", "known", "--actor", "known", "--capabilities", "effect", "--json"],
      [cli, "onboard", "--space", "known", "--actor", "known", "--capabilities", "propose", "--json"],
      [cli, "onboard", "--space", "known", "--actor", "known", "--capabilities", "coordinate", "--json"],
    ];
    for (const [index, argv] of cases.entries()) {
      const home = join(root, `invalid cold home ${index}`);
      mkdirSync(home, { recursive: true });
      const result = await run(argv, { home });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe("");
      const problem = JSON.parse(result.stdout);
      expect(problem).toMatchObject({
        contractVersion: "tasq.autonomous-bootstrap-problem.v1",
        status: "error",
        retryable: false,
      });
      expect(problem.nextActions[0].argv[0]).toBe(realpathSync(join(release, "index.js")));
      expect(existsSync(join(home, ".tasq state"))).toBe(false);
    }
  });
});

describe("TQ-316 contamination guard", () => {
  test("all black-box readers remain provider-neutral and do not read device time", () => {
    for (const name of [
      "bootstrap-version-client.mjs",
      "discovery-recipe-client.py",
      "discovery-recipe-client.mjs",
      "discovery-recipe-client.sh",
      "raw-mcp-client.mjs",
    ]) {
      const source = readFileSync(join(fixtures, name), "utf8").toLowerCase();
      for (const forbidden of [
        "@kami/", "gmail", "mercury", "github", "_life", "date.now", "datetime.now",
        "performance.now", "process.hrtime", "products/tasq",
      ]) {
        expect(source, `${name} contains forbidden knowledge: ${forbidden}`).not.toContain(forbidden);
      }
      if (name.startsWith("discovery-recipe-client")) {
        expect(source, `${name} rewrites the discovered executable`).not.toContain("argv[0] =");
        expect(source, `${name} substitutes the pointer executable`).not.toContain("pointerargv[0]");
      }
    }
  });
});
