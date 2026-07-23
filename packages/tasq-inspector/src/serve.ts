import {
  CONSOLE_LISTENER_CONTRACT_VERSION,
  ConsoleListenerDescriptor as ConsoleListenerDescriptorSchema,
  type Clock,
  type ConsoleListenerDescriptor,
} from "@tasq-run/schema";
import type { TasqDb } from "@tasq-run/core";
import { createTasqInspectorHandler } from "./server.js";
import { assertLoopbackHost } from "./loopback.js";

export { assertLoopbackHost } from "./loopback.js";

function assertPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Tasq inspector port must be an integer between 0 and 65535");
  }
  return value;
}

export interface StartTasqInspectorServerOptions {
  db: TasqDb;
  workspaceId: string;
  clock: Clock;
  hostname?: string;
  port?: number;
  onError?: (error: unknown) => void;
  /** Tasq Local SemVer embedded into release artifacts. */
  productVersion?: string;
  /** Injectable listener identity for deterministic tests. */
  instanceId?: string;
  /** Injectable process identity for deterministic tests. */
  processId?: number;
}

export interface TasqInspectorServer {
  hostname: string;
  port: number;
  url: string;
  descriptor: ConsoleListenerDescriptor;
  stop(): Promise<void>;
}

export function startTasqInspectorServer(
  options: StartTasqInspectorServerOptions,
): TasqInspectorServer {
  const hostname = assertLoopbackHost(options.hostname ?? "127.0.0.1");
  const port = assertPort(options.port ?? 4_137);
  const startedAt = options.clock.now();
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const productVersion = options.productVersion ?? "0.1.0";
  const processId = options.processId ?? process.pid;
  const preflightPort = port === 0 ? 1 : port;
  const preflightHost = hostname === "::1" ? "[::1]" : hostname;
  // Validate every caller-controlled identity field before opening a socket.
  ConsoleListenerDescriptorSchema.parse({
    contractVersion: CONSOLE_LISTENER_CONTRACT_VERSION,
    instanceId,
    productVersion,
    workspaceId: options.workspaceId,
    startedAt,
    endpoint: {
      url: `http://${preflightHost}:${preflightPort}`,
      hostname,
      port: preflightPort,
      transport: "http",
      scope: "loopback",
    },
    access: { readOnly: true, authentication: "none" },
    process: { mode: "foreground", pid: processId, shutdownSignals: ["SIGINT", "SIGTERM"] },
  });
  let descriptor: ConsoleListenerDescriptor | null = null;
  const server = Bun.serve({
    hostname,
    port,
    fetch: createTasqInspectorHandler({ ...options, runtime: () => descriptor }),
  });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("Tasq inspector listener did not expose a bound port");
  }
  const urlHost = hostname === "::1" ? "[::1]" : hostname;
  const url = `http://${urlHost}:${server.port}`;
  try {
    descriptor = ConsoleListenerDescriptorSchema.parse({
      contractVersion: CONSOLE_LISTENER_CONTRACT_VERSION,
      instanceId,
      productVersion,
      workspaceId: options.workspaceId,
      startedAt,
      endpoint: { url, hostname, port: server.port, transport: "http", scope: "loopback" },
      access: { readOnly: true, authentication: "none" },
      process: { mode: "foreground", pid: processId, shutdownSignals: ["SIGINT", "SIGTERM"] },
    });
  } catch (error) {
    void server.stop(true);
    throw error;
  }
  return {
    hostname,
    port: server.port,
    url,
    descriptor,
    async stop() {
      await server.stop(true);
    },
  };
}
