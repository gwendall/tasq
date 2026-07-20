import { describe, expect, test } from "bun:test";

describe("minimal universal kernel composition", () => {
  test("boots and completes a commitment without loading bundled profiles", async () => {
    const fixture = new URL("./fixtures/minimal-kernel-boot.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "run", fixture], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      status: "done",
      workspaceId: "robotics-lab",
      profileFieldsExposed: false,
      profileInputRejected: true,
      inspectionContract: "tasq.inspect.v1",
      inspectionProfileFieldsExposed: false,
      referenceExtensions: 0,
      planningRows: 0,
    });
  });
});
