/**
 * `--actor` is self-asserted. Locally that is not a hole - anyone who can pass
 * the flag can also open the store directly - but the principal is derived
 * from (space, alias), so two machines using one label are ONE principal and
 * the ledger merged them without a word. These prove the merge is now visible.
 */

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { openDb } from "@tasq-internal/local-service";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "index.ts");
const temporary: string[] = [];
setDefaultTimeout(60_000);

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

/** One store, several homes: the shape of a shared ledger on two machines. */
function sharedLedger() {
  const base = mkdtempSync(join(tmpdir(), "tasq-device-"));
  temporary.push(base);
  const project = join(base, "project");
  mkdirSync(project, { recursive: true });
  return { base, project, store: join(base, "shared.sqlite") };
}

async function run(home: string, project: string, store: string, argv: string[]) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const child = Bun.spawn(["bun", "run", cli, ...argv], {
    cwd: project,
    env: { PATH: process.env.PATH ?? "", HOME: home, TASQ_DB_URL: `file:${store}` },
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

async function ok(home: string, project: string, store: string, argv: string[]) {
  const result = await run(home, project, store, argv);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

async function bindings(store: string): Promise<Array<Record<string, unknown>>> {
  const handle = await openDb({ url: `file:${store}` });
  try {
    const rows = await handle.client.execute("SELECT * FROM principal_device ORDER BY fingerprint");
    return rows.rows as unknown as Array<Record<string, unknown>>;
  } finally {
    await handle.close();
  }
}

describe("device identity", () => {
  test("names the other device that has written under the same actor label", async () => {
    const { base, project, store } = sharedLedger();
    const laptop = join(base, "laptop");
    const desktop = join(base, "desktop");
    const join_ = ["setup", "--space", "acme/app", "--actor", "gwendall", "--no-bind", "--no-instructions"];

    await ok(laptop, project, store, join_);
    await ok(laptop, project, store, ["add", "From the laptop", "--json"]);
    await ok(desktop, project, store, join_);
    await ok(desktop, project, store, ["add", "From the desktop", "--json"]);

    // Two devices, one principal: exactly the collision the label allows.
    const rows = await bindings(store);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row["principal_id"])).size).toBe(1);

    const seen = JSON.parse((await ok(laptop, project, store, ["whoami", "--json"])).stdout);
    expect(seen).toMatchObject({
      contractVersion: "tasq.whoami.v1",
      space: "acme/app",
      actor: "gwendall",
      actorAuthentication: "local_process_self_asserted",
    });
    expect(seen.devicesSeenForThisPrincipal).toHaveLength(2);
    expect(seen.devicesSeenForThisPrincipal.filter((d: { thisDevice: boolean }) => d.thisDevice)).toHaveLength(1);
    expect(seen.principalsUsedByMoreThanOneDevice[0].fingerprints).toHaveLength(2);

    // The prose has to say what it is worth, or an identity reads as proof.
    const printed = (await ok(laptop, project, store, ["whoami"])).stdout;
    expect(printed).toContain("other device(s) have written as gwendall");
    expect(printed).toContain("attribution, not authentication");
  });

  test("a read leaves no mark, because attribution belongs to writes", async () => {
    const { base, project, store } = sharedLedger();
    const home = join(base, "home");
    await ok(home, project, store, [
      "setup", "--space", "acme/app", "--actor", "gwendall", "--no-bind", "--no-instructions",
    ]);
    // Setup establishes the key but writes no work, so nothing is attributed
    // yet. The binding appears with the first domain mutation.
    expect(await bindings(store)).toHaveLength(0);
    await ok(home, project, store, ["add", "Something real", "--json"]);
    expect(await bindings(store)).toHaveLength(1);

    await ok(home, project, store, ["list", "--json"]);
    await ok(home, project, store, ["whoami", "--json"]);
    expect(await bindings(store)).toHaveLength(1);
  });

  test("keeps the private half private, and never puts it in the ledger", async () => {
    const { base, project, store } = sharedLedger();
    const home = join(base, "home");
    await ok(home, project, store, [
      "setup", "--space", "acme/app", "--actor", "gwendall", "--no-bind", "--no-instructions",
    ]);
    const keyPath = join(home, ".tasq", "device.json");
    // Group or other readable would make the key worth exactly the file mode.
    expect(statSync(keyPath).mode & 0o077).toBe(0);

    const key = JSON.parse(readFileSync(keyPath, "utf8"));
    expect(key).toMatchObject({ contractVersion: "tasq.device-identity.v1", algorithm: "ed25519" });

    await ok(home, project, store, ["add", "Attributed work", "--json"]);
    const stored = await bindings(store);
    expect(stored[0]!["public_key"]).toBe(key.publicKey);
    // The ledger holds the public half only. Nothing anywhere else may carry
    // the private one.
    expect(JSON.stringify(stored)).not.toContain(key.privateKey);
  });

  test("a home it cannot write to costs the command nothing", async () => {
    // Attribution detail must never turn a mutation the user asked for into a
    // failure. A corrupt key file is the cheapest way to reach that path.
    const { base, project, store } = sharedLedger();
    const home = join(base, "home");
    mkdirSync(join(home, ".tasq"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".tasq", "device.json"), "not json at all", "utf8");

    await ok(home, project, store, [
      "setup", "--space", "acme/app", "--actor", "gwendall", "--no-bind", "--no-instructions",
    ]);
    const created = JSON.parse((await ok(home, project, store, ["add", "Still works", "--json"])).stdout);
    expect(created.id).toBeTruthy();
    expect(await bindings(store)).toHaveLength(0);

    const seen = JSON.parse((await ok(home, project, store, ["whoami", "--json"])).stdout);
    expect(seen.device).toBeNull();
  });
});
