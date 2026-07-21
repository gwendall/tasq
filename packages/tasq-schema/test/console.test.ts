import { describe, expect, test } from "bun:test";
import {
  CONSOLE_DISCOVERY_CONTRACT_VERSION,
  CONSOLE_LISTENER_CONTRACT_VERSION,
  ConsoleDiscovery,
  ConsoleListenerDescriptor,
  createMutableClock,
} from "../src/index.js";

describe("Local Console listener contracts", () => {
  const clock = createMutableClock(10_000);
  const listener = ConsoleListenerDescriptor.parse({
    contractVersion: CONSOLE_LISTENER_CONTRACT_VERSION,
    instanceId: "018f47a2-6ce4-4b90-8f43-444444444444",
    productVersion: "1.2.3-rc.1",
    workspaceId: "robotics/team-a",
    startedAt: clock.now(),
    endpoint: {
      url: "http://127.0.0.1:4137",
      hostname: "127.0.0.1",
      port: 4_137,
      transport: "http",
      scope: "loopback",
    },
    access: { readOnly: true, authentication: "none" },
    process: { mode: "foreground", pid: 42, shutdownSignals: ["SIGINT", "SIGTERM"] },
  });

  test("accepts one exact injected-time foreground announcement", () => {
    expect(listener).toMatchObject({ startedAt: 10_000, productVersion: "1.2.3-rc.1" });
    expect(ConsoleDiscovery.parse({
      contractVersion: CONSOLE_DISCOVERY_CONTRACT_VERSION,
      workspaceId: listener.workspaceId,
      state: "running",
      descriptor: listener,
      reason: null,
    })).toMatchObject({ state: "running", descriptor: { instanceId: listener.instanceId } });
  });

  test("rejects remote, mutable, unversioned or internally inconsistent claims", () => {
    for (const change of [
      { productVersion: "latest" },
      { endpoint: { ...listener.endpoint, hostname: "0.0.0.0" } },
      { endpoint: { ...listener.endpoint, url: "https://example.com" } },
      { endpoint: { ...listener.endpoint, port: 0 } },
      { access: { readOnly: false, authentication: "none" } },
      { process: { ...listener.process, mode: "daemon" } },
    ]) {
      expect(() => ConsoleListenerDescriptor.parse({ ...listener, ...change })).toThrow();
    }
    expect(() => ConsoleDiscovery.parse({
      contractVersion: CONSOLE_DISCOVERY_CONTRACT_VERSION,
      workspaceId: listener.workspaceId,
      state: "running",
      descriptor: null,
      reason: "listener_unreachable",
    })).toThrow();
  });
});
