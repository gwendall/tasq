import { expect, test } from "bun:test";
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
  expect(`${stdout}\n${stderr}`).toContain("Ran 4 tests");
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
