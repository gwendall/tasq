import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { StatementBinderDescriptorV1, canonicalizeEffectJson } from "@tasq-run/schema";

test("TQ-624 TypeScript and Python agree on the portable binder descriptor", async () => {
  const fixtures = join(import.meta.dir, "fixtures");
  const vectorPath = join(fixtures, "statement-binder-registry-vector.json");
  const vector = await Bun.file(vectorPath).json();
  const descriptor = StatementBinderDescriptorV1.parse(vector.descriptor);
  const canonical = canonicalizeEffectJson(descriptor as never);
  expect(canonical).toBe(vector.canonicalDescriptor);
  expect(`sha256:${createHash("sha256").update(canonical).digest("hex")}`)
    .toBe(vector.descriptorDigest);

  const process = Bun.spawn([
    "python3",
    join(fixtures, "verify-statement-binder-registry-vector.py"),
    vectorPath,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    contractVersion: "tasq.statement-binder-registry-vector.v1",
    descriptorDigest: vector.descriptorDigest,
    verified: true,
  });
});
