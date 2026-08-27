/** Exact-byte migration replay for a protected published Tasq Local release. */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createClient } from "@libsql/client";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(180_000);

const roots: string[] = [];
const releaseDirectory = process.env.TASQ_PUBLISHED_RELEASE_DIR;
const version = (process.env.TASQ_PUBLISHED_RELEASE_VERSION ?? "v0.1.0").replace(/^v/, "");
const sourceCommit = process.env.TASQ_PUBLISHED_SOURCE_COMMIT;
const target = process.platform === "darwin" && process.arch === "arm64"
  ? "darwin-arm64"
  : process.platform === "linux" && process.arch === "x64"
    ? "linux-x64-gnu"
    : null;
const fixture = resolve(import.meta.dir, "../tasq-service/test/fixtures/pre-0006-populated.sql");
/** The format the fixture is frozen at. Store formats are zero-based migration
 *  identifiers, so format N has exactly N + 1 applied rows. */
const legacyFormat = 5;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(executable: string, args: string[], home?: string) {
  const child = Bun.spawn([executable, ...args], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", ...(home ? { TASQ_HOME: home } : {}) },
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

describe.skipIf(releaseDirectory === undefined || target === null)("published release migration replay", () => {
  test("refuses to migrate unasked, then migrates on the deliberate upgrade, through the downloaded protected binary", async () => {
    expect(sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const root = await mkdtemp(join(tmpdir(), "tasq-published-replay-"));
    roots.push(root);
    const prefix = join(root, "prefix");
    const home = join(root, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });

    const stem = `tasq-v${version}-${target}`;
    const installer = join(releaseDirectory!, `${stem}.install.ts`);
    await chmod(installer, 0o755);
    const installed = await run(installer, [
      "install",
      "--archive", join(releaseDirectory!, `${stem}.tar.gz`),
      "--manifest", join(releaseDirectory!, `${stem}.release.json`),
      "--checksums", join(releaseDirectory!, `${stem}.SHA256SUMS`),
      "--prefix", prefix,
    ]);
    expect(installed, installed.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(installed.stdout)).toMatchObject({ version, target });
    const releaseManifest = JSON.parse(await readFile(
      join(releaseDirectory!, `${stem}.release.json`),
      "utf8",
    ));
    expect(releaseManifest).toMatchObject({ version, source: { commit: sourceCommit }, target });
    const publishedStoreFormat = releaseManifest.compatibility?.storeFormat?.current;
    expect(publishedStoreFormat).toBeNumber();

    const databasePath = join(home, "db.sqlite");
    const seeded = createClient({ url: `file:${databasePath}` });
    await seeded.executeMultiple(await readFile(fixture, "utf8"));
    await seeded.close();
    await chmod(databasePath, 0o600);

    const cli = join(prefix, "bin", "tasq");
    expect(await run(cli, ["--version"], home)).toMatchObject({ exitCode: 0, stdout: `${version}\n` });

    // FIRST, the refusal. Crossing a store format is a decision, not a side
    // effect of whatever command ran first: a shared ledger migrated by
    // surprise locks out every older Tasq still reading it. Certifying this
    // against a DOWNLOADED artifact is the point - the working tree can always
    // be made to behave, and the thing operators actually run is this file.
    const unasked = await run(cli, [
      "onboard", "--space", "published/migration", "--actor", "certifier", "--json",
    ], home);
    expect(unasked.exitCode, unasked.stdout).not.toBe(0);
    // Under --json the refusal is a structured problem document, not prose on
    // stderr. An agent has to be able to ACT on this, so the assertion is on
    // the shape rather than on a substring that could survive a rewrite.
    const refusal = JSON.parse(unasked.stdout);
    expect(refusal).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap-problem.v1",
      status: "error",
      code: "unavailable",
    });
    expect(refusal.message).toContain(`This store is format ${legacyFormat}`);
    expect(refusal.message).toContain("irreversible upgrade");
    // Naming the way out is the difference between a refusal and a dead end.
    expect(refusal.message).toContain("tasq store upgrade");
    expect(refusal.message).toContain("tasq store restore");

    // And it refused without touching anything, which is the half a refusal
    // message cannot prove on its own.
    const untouched = createClient({ url: `file:${databasePath}` });
    const before = await untouched.execute("SELECT count(*) AS count FROM _migration");
    await untouched.close();
    expect(Number(before.rows[0]?.count)).toBe(legacyFormat + 1);

    // THEN the deliberate path. A certification replay represents an operator
    // upgrading, and an operator types this.
    const upgraded = await run(cli, [
      "store", "upgrade", "--tenant", "published/migration", "--actor", "certifier", "--json",
    ], home);
    expect(upgraded, upgraded.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(upgraded.stdout)).toMatchObject({
      contractVersion: "tasq.store-upgrade.v1",
      ok: true,
      upgraded: true,
      formatBefore: legacyFormat,
      formatAfter: publishedStoreFormat,
    });
    // The upgrade names the recovery point it wrote, because a rollback rule
    // nobody can find is not a rollback rule.
    expect(JSON.parse(upgraded.stdout).recoveryPointId).toBeTruthy();

    const onboarded = await run(cli, [
      "onboard", "--space", "published/migration", "--actor", "certifier", "--json",
    ], home);
    expect(onboarded, onboarded.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(onboarded.stdout)).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      space: { workspaceId: "published/migration" },
    });

    const verified = createClient({ url: `file:${databasePath}` });
    const migrations = await verified.execute("SELECT count(*) AS count FROM _migration");
    await verified.close();
    expect(Number(migrations.rows[0]?.count)).toBe(publishedStoreFormat + 1);

    const receipts = (await readdir(`${databasePath}.tasq-migrations`))
      .filter((name) => name.startsWith("receipt-") && name.endsWith(".json"));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(await readFile(
      join(`${databasePath}.tasq-migrations`, receipts[0]!),
      "utf8",
    ))).toMatchObject({
      status: "complete",
      source: { format: legacyFormat },
      target: { format: publishedStoreFormat },
      snapshot: { verification: { ok: true } },
    });

    const doctor = await run(cli, [
      "doctor", "--tenant", "published/migration", "--actor", "certifier", "--json",
    ], home);
    expect(doctor, doctor.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true });
  });
});
