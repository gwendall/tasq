/**
 * Shared pieces of the three release-pipeline commands:
 * `release:prepare`, `release:publish-surfaces`, `release:record`.
 *
 * The release itself was already scripted end to end - preflight, protected
 * workflow, certification, installer generator, publication verifier. What
 * was still done by hand, twice on 2026-09-06, was moving the version-pinned
 * policy blocks before the tag and filling every public surface after
 * publication. Both are deterministic edits of files this repository owns,
 * so they are commands now, and "every surface" is the default: the v0.6.2
 * release shipped without the server image and the Python wheel because
 * their candidate blocks were never authorized before the tag, and an
 * immutable tag cannot be authorized afterwards.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { systemClock } from "@tasq-run/schema";

export const productRoot = resolve(import.meta.dir, "../..");

export type Surface = "server" | "python" | "client";
export const ALL_SURFACES: readonly Surface[] = ["server", "python", "client"];

export const SURFACES = {
  server: {
    candidate: "serverImage",
    publishWorkflow: "publish-server.yml",
    publishConfirmation: "publish-tasq-server",
    certifyWorkflow: "certify-published-server.yml",
    certifyConfirmation: "certify-tasq-server",
  },
  python: {
    candidate: "pythonWheel",
    publishWorkflow: "publish-python.yml",
    publishConfirmation: "publish-tasq-python",
    certifyWorkflow: "certify-published-python.yml",
    certifyConfirmation: "certify-tasq-python",
  },
  client: {
    candidate: "remoteTypeScriptClient",
    publishWorkflow: "release.yml",
    publishConfirmation: null,
    certifyWorkflow: "certify-published-release.yml",
    certifyConfirmation: null,
  },
} as const;

export const FLY_CONFIRMATION = "deploy-tasq-fly-beta";
export const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export function fail(message: string): never {
  throw new Error(message);
}

/** `--name value` pairs and bare `--switch` flags, refusing anything unknown. */
export function parseFlags(argv: string[], valued: readonly string[], switches: readonly string[] = []) {
  const values = new Map<string, string>();
  const on = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;
    if (switches.includes(name)) { on.add(name); continue; }
    if (!valued.includes(name)) fail(`unknown flag ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
    if (values.has(name)) fail(`duplicate flag ${name}`);
    values.set(name, value);
    index++;
  }
  return {
    get: (name: string) => values.get(name),
    require: (name: string) => values.get(name) ?? fail(`${name} is required`),
    has: (name: string) => on.has(name),
  };
}

export function parseSurfaces(value: string | undefined): Surface[] {
  if (value === undefined || value === "all") return [...ALL_SURFACES];
  if (value === "none") return [];
  const surfaces = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (const surface of surfaces) {
    if (!ALL_SURFACES.includes(surface as Surface)) fail(`unknown surface ${surface}; expected ${ALL_SURFACES.join(", ")}, all or none`);
  }
  return surfaces as Surface[];
}

/** Today as an explicit calendar date, from the system clock adapter. */
export function today(): string {
  return new Date(systemClock.now()).toISOString().slice(0, 10);
}

export async function readJson<T = any>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function policyPath(root: string): string {
  return resolve(root, "docs/releases/PUBLIC_RELEASE_POLICY.json");
}

/** Run a command and return its trimmed stdout; a non-zero exit is an error naming the command. */
export function sh(argv: string[], options: { cwd?: string; allowFailure?: boolean } = {}): string {
  const child = Bun.spawnSync(argv, { cwd: options.cwd ?? productRoot, stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout.toString().trim();
  if (child.exitCode !== 0 && !options.allowFailure) {
    fail(`${argv.join(" ")} failed (${child.exitCode}): ${child.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
  }
  return child.exitCode === 0 ? stdout : "";
}

export function ghJson<T = any>(argv: string[]): T {
  return JSON.parse(sh(["gh", ...argv])) as T;
}

/** The commit an annotated or lightweight tag points at. */
export function tagCommit(tag: string): string {
  const commit = sh(["git", "rev-list", "-n", "1", tag]);
  if (!/^[a-f0-9]{40}$/.test(commit)) fail(`tag ${tag} does not resolve to a commit`);
  return commit;
}

/** The newest workflow run for a workflow file whose head commit matches; null when none. */
export function findRun(workflow: string, headSha: string): { databaseId: number; url: string; status: string; conclusion: string | null } | null {
  const runs = ghJson<Array<{ databaseId: number; url: string; status: string; conclusion: string | null; headSha: string }>>([
    "run", "list", "--workflow", workflow, "--limit", "20", "--json", "databaseId,url,status,conclusion,headSha",
  ]);
  return runs.find((run) => run.headSha === headSha) ?? null;
}

/** Dispatch a workflow and return the run it started, found by head commit after dispatch. */
export async function dispatch(workflow: string, ref: string, inputs: Record<string, string>): Promise<{ databaseId: number; url: string }> {
  const before = new Set(
    ghJson<Array<{ databaseId: number }>>(["run", "list", "--workflow", workflow, "--limit", "20", "--json", "databaseId"]).map((run) => run.databaseId),
  );
  const args = ["workflow", "run", workflow, "--ref", ref];
  for (const [name, value] of Object.entries(inputs)) args.push("-f", `${name}=${value}`);
  sh(["gh", ...args]);
  for (let attempt = 0; attempt < 30; attempt++) {
    await Bun.sleep(5_000);
    const runs = ghJson<Array<{ databaseId: number; url: string }>>(["run", "list", "--workflow", workflow, "--limit", "20", "--json", "databaseId,url"]);
    const started = runs.find((run) => !before.has(run.databaseId));
    if (started) return started;
  }
  fail(`${workflow} was dispatched but no new run appeared within 150 seconds`);
}

/** Wait for a run to complete; returns its conclusion. */
export async function waitForRun(databaseId: number, pollSeconds = 60): Promise<{ conclusion: string; url: string }> {
  while (true) {
    const run = ghJson<{ status: string; conclusion: string | null; url: string }>(["run", "view", String(databaseId), "--json", "status,conclusion,url"]);
    if (run.status === "completed") return { conclusion: run.conclusion ?? "unknown", url: run.url };
    await Bun.sleep(pollSeconds * 1000);
  }
}

/** The immutable digest GHCR holds for the server image tagged with a version. */
export function ghcrDigestForVersion(version: string): string {
  const versions = ghJson<Array<{ name: string; metadata?: { container?: { tags?: string[] } } }>>([
    "api", "/users/gwendall/packages/container/tasq-server/versions", "--paginate",
  ]);
  const match = versions.find((entry) => entry.metadata?.container?.tags?.includes(version));
  if (!match || !/^sha256:[a-f0-9]{64}$/.test(match.name)) fail(`no ghcr.io/gwendall/tasq-server image is tagged ${version}`);
  return match.name;
}

/**
 * The sha256 PyPI records for the wheel of a version, once `pip` can see it.
 *
 * PyPI serves two indexes and they do not update together: the JSON API
 * carries a new release before the simple index `pip` resolves against does.
 * v0.6.6 read the digest from the JSON API, dispatched the certification two
 * minutes later, and the certifier's `pip download` failed with "from
 * versions: 0.4.0, 0.6.3, 0.6.4, 0.6.5" - the wheel was published, and the
 * index it installs from had not caught up. So both indexes are polled here,
 * and the digest is only returned once the file the certifier will ask for is
 * one the simple index lists.
 */
export async function pypiWheelSha256(version: string, attempts = 20, pollMs = 15_000): Promise<string> {
  let wheel: { filename: string; digests: { sha256: string } } | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await Bun.sleep(pollMs);
    if (!wheel) {
      const response = await fetch(`https://pypi.org/pypi/tasq-remote/${version}/json`, { cache: "no-store" });
      if (response.status === 404) continue;
      if (!response.ok) fail(`PyPI returned HTTP ${response.status} for tasq-remote ${version}`);
      const body = await response.json() as { urls: Array<{ filename: string; digests: { sha256: string } }> };
      wheel = body.urls.find((entry) => entry.filename.endsWith(".whl"));
      if (!wheel) continue;
    }
    const simple = await fetch("https://pypi.org/simple/tasq-remote/", { cache: "no-store" });
    if (!simple.ok) fail(`PyPI simple index returned HTTP ${simple.status} for tasq-remote`);
    if ((await simple.text()).includes(wheel.filename)) return wheel.digests.sha256;
  }
  fail(
    wheel
      ? `PyPI still does not list ${wheel.filename} on its simple index; the certifier's pip download would fail`
      : `PyPI holds no wheel for tasq-remote ${version}`,
  );
}

export function npmVersionExists(pkg: string, version: string): boolean {
  return sh(["npm", "view", `${pkg}@${version}`, "version"], { allowFailure: true }) === version;
}
