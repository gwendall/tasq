import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("TQ-810 Python client passes from a clean interpreter without kernel dependencies", async () => {
  const root = join(import.meta.dir, "..", "..", "clients", "python");
  const child = Bun.spawn([
    "python3",
    "-m",
    "unittest",
    "discover",
    "-s",
    "tests",
    "-v",
  ], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: root,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("Ran 6 tests");
});

test("TQ-810 checked-in OpenAPI exposes the same bounded remote journeys", async () => {
  const document = await Bun.file(join(
    import.meta.dir,
    "..",
    "..",
    "docs",
    "contracts",
    "TASQ_REMOTE_API.openapi.json",
  )).json() as {
    openapi: string;
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  expect(document.openapi).toBe("3.1.0");
  expect(Object.values(document.paths)
    .flatMap((path) => Object.values(path))
    .map(({ operationId }) => operationId)
    .filter(Boolean)
    .sort()).toEqual([
    "executeOperation",
    "getCommitment",
    "listCommitments",
    "listEvents",
    "listOperations",
    "redeemEnrollment",
  ]);
});

test("TQ-810 protected harness uses the installed wheel against one exact Server digest", async () => {
  const scenario = await readFile(join(
    import.meta.dir,
    "..",
    "..",
    "scripts",
    "release",
    "certify_published_python_server.py",
  ), "utf8");
  expect(scenario).toContain("from tasq_remote import");
  expect(scenario).toContain("Path(sys.prefix).resolve()");
  expect(scenario).toContain("redeem_remote_enrollment");
  expect(scenario).toContain("client.list_commitments(limit=10)");
  expect(scenario).toContain('"operation_id": "commitment.propose"');
  expect(scenario).toContain("TasqRemoteError");
  expect(scenario).toContain('"exactMutationReplay": True');
  expect(scenario).toContain('"publicSupportClaim": False');
  expect(scenario).toContain("--read-only");
  expect(scenario).toContain("--cap-drop");
  expect(scenario).not.toContain("clients/python");
  expect(scenario).not.toContain("packages/tasq-server");
});
