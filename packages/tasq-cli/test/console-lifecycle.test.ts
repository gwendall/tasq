import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONSOLE_LISTENER_CONTRACT_VERSION,
  ConsoleListenerDescriptor,
  createMutableClock,
} from "@tasq-run/schema";
import {
  consoleRegistrationPath,
  discoverConsole,
  prepareConsoleRegistration,
  registerConsole,
  unregisterConsole,
} from "../src/console-lifecycle.js";

describe.serial("Console registration lifecycle", () => {
  let home: string;
  let originalHome: string | undefined;
  const clock = createMutableClock(123_456);

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "tasq-console-registration-"));
    originalHome = process.env.TASQ_HOME;
    process.env.TASQ_HOME = home;
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env.TASQ_HOME;
    else process.env.TASQ_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  function descriptor(workspaceId: string, pid = process.pid) {
    return ConsoleListenerDescriptor.parse({
      contractVersion: CONSOLE_LISTENER_CONTRACT_VERSION,
      instanceId: "018f47a2-6ce4-4b90-8f43-222222222222",
      productVersion: "1.2.3-test.1",
      workspaceId,
      startedAt: clock.now(),
      endpoint: {
        url: "http://127.0.0.1:65534",
        hostname: "127.0.0.1",
        port: 65_534,
        transport: "http",
        scope: "loopback",
      },
      access: { readOnly: true, authentication: "none" },
      process: { mode: "foreground", pid, shutdownSignals: ["SIGINT", "SIGTERM"] },
    });
  }

  test("uses private atomic files and removes only its own instance", async () => {
    const workspaceId = "registration/private";
    const registered = descriptor(workspaceId, 2_147_483_647);
    const path = await registerConsole(registered);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(registered);
    await expect(registerConsole(registered)).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(registered);

    const other = { ...registered, instanceId: "018f47a2-6ce4-4b90-8f43-333333333333" };
    await unregisterConsole(other);
    expect((await stat(path)).isFile()).toBe(true);
    await unregisterConsole(registered);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reclaims only an unreachable descriptor whose process is gone", async () => {
    const workspaceId = "registration/crashed";
    await registerConsole(descriptor(workspaceId, 2_147_483_647));
    expect(await discoverConsole(workspaceId)).toMatchObject({
      contractVersion: "tasq.console-discovery.v1",
      state: "stale",
      reason: "listener_unreachable",
    });
    await prepareConsoleRegistration(workspaceId);
    expect(await discoverConsole(workspaceId)).toMatchObject({ state: "stopped", reason: "not_registered" });
  });

  test("fails closed for invalid registration or an owner process that may still be alive", async () => {
    const invalidWorkspace = "registration/invalid";
    const invalidPath = consoleRegistrationPath(invalidWorkspace);
    await mkdir(dirname(invalidPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(invalidPath), 0o700);
    await writeFile(invalidPath, "not-json\n", { mode: 0o600 });
    expect(await discoverConsole(invalidWorkspace)).toMatchObject({ state: "stale", reason: "descriptor_invalid" });
    await expect(prepareConsoleRegistration(invalidWorkspace)).rejects.toThrow(/registration is invalid/);

    const aliveWorkspace = "registration/alive";
    await registerConsole(descriptor(aliveWorkspace));
    await expect(prepareConsoleRegistration(aliveWorkspace)).rejects.toThrow(/already registered/);
    expect((await stat(consoleRegistrationPath(aliveWorkspace))).isFile()).toBe(true);
  });
});
