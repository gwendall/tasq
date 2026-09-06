/**
 * A context link is found from the thing it points at.
 *
 * The provenance of a commitment born in a chat is a link to the message. The
 * two questions that come back are "has this message already become a
 * commitment" and "who reported this one", and both are answered by the
 * target index rather than by scanning commitments.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "index.ts");
const temporary: string[] = [];
setDefaultTimeout(90_000);
const PROVENANCE = "https://schemas.tasq.dev/context-link-purposes/provenance";
const REPORTER = "https://schemas.tasq.dev/context-link-purposes/reporter";

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "tasq-link-target-"));
  temporary.push(base);
  const home = join(base, "home"); const project = join(base, "project");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(project, { recursive: true });
  return { home, project };
}
afterEach(() => { while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true }); });

async function run(home: string, cwd: string, argv: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...argv], {
    cwd, env: { ...process.env, HOME: home, TASQ_HOME: join(home, ".tasq"), TASQ_DB_URL: "", TASQ_EVENT_JOURNAL_PATH: "", TASQ_TENANT: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}
async function json(home: string, cwd: string, argv: string[]) {
  const result = await run(home, cwd, [...argv, "--json"]);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${result.exitCode})\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe("context links by target", () => {
  test("one message linked to two commitments is found from the message, and reporters are found by purpose", async () => {
    const { home, project } = sandbox();
    await json(home, project, ["setup", "--space", "acme/app", "--actor", "kami:daemon"]);
    const first = await json(home, project, ["add", "The login button does nothing"]);
    const second = await json(home, project, ["add", "Login is broken on mobile too"]);
    const message = ["--system", "https://telegram.org", "--resource-type", "chat.message", "--external-id", "123456/789"];
    await json(home, project, ["context-link", "attach", first.id, "--purpose", PROVENANCE, ...message, "--digest", `sha256:${"a".repeat(64)}`, "--idempotency-key", "p1"]);
    await json(home, project, ["context-link", "attach", second.id, "--purpose", PROVENANCE, ...message, "--digest", `sha256:${"a".repeat(64)}`, "--idempotency-key", "p2"]);
    await json(home, project, ["context-link", "attach", first.id, "--purpose", REPORTER, "--system", "https://telegram.org", "--resource-type", "chat.user", "--external-id", "42", "--idempotency-key", "r1"]);
    await json(home, project, ["context-link", "attach", first.id, "--purpose", REPORTER, "--system", "https://telegram.org", "--resource-type", "chat.user", "--external-id", "43", "--idempotency-key", "r2"]);

    const byMessage = await json(home, project, ["context-link", "list", ...message]);
    expect(byMessage.contractVersion).toBe("tasq.external-context-link-page.v1");
    expect(byMessage.items.map((item: { commitmentId: string }) => item.commitmentId).sort()).toEqual([first.id, second.id].sort());

    const reporters = await json(home, project, ["context-link", "list", first.id, "--purpose", REPORTER]);
    expect(reporters.items.map((item: { target: { externalId: string } }) => item.target.externalId).sort()).toEqual(["42", "43"]);
    const provenanceOnly = await json(home, project, ["context-link", "list", first.id, "--purpose", PROVENANCE]);
    expect(provenanceOnly.items).toHaveLength(1);

    // Nobody else reported the second one.
    const none = await json(home, project, ["context-link", "list", second.id, "--purpose", REPORTER]);
    expect(none.items).toEqual([]);
  });

  test("a listing needs a commitment or a whole target, never both, never neither", async () => {
    const { home, project } = sandbox();
    await json(home, project, ["setup", "--space", "acme/app", "--actor", "kami:daemon"]);
    const task = await json(home, project, ["add", "Something"]);
    const partial = await run(home, project, ["context-link", "list", "--system", "https://telegram.org", "--json"]);
    expect(partial.exitCode).not.toBe(0);
    expect(partial.stderr).toContain("--system, --resource-type and --external-id together");
    const both = await run(home, project, ["context-link", "list", task.id, "--system", "https://telegram.org", "--resource-type", "chat.message", "--external-id", "1/1", "--json"]);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("not both");
    const neither = await run(home, project, ["context-link", "list", "--json"]);
    expect(neither.exitCode).not.toBe(0);
  });
});
