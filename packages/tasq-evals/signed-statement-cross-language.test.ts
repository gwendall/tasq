import { expect, test } from "bun:test";
import { join } from "node:path";

test("TQ-613 Python independently rebuilds PAE and verifies the Ed25519 vector", async () => {
  const fixtures = join(import.meta.dir, "fixtures");
  const process = Bun.spawn([
    "python3",
    join(fixtures, "verify-signed-statement-vector.py"),
    join(fixtures, "signed-statement-vector.json"),
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    contractVersion: "tasq.signed-statement-vector.v1",
    verified: true,
  });
});
