import type { Clock } from "@tasq/schema";
import type { TasqDb } from "@tasq/core";
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
}

export interface TasqInspectorServer {
  hostname: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

export function startTasqInspectorServer(
  options: StartTasqInspectorServerOptions,
): TasqInspectorServer {
  const hostname = assertLoopbackHost(options.hostname ?? "127.0.0.1");
  const port = assertPort(options.port ?? 4_137);
  const server = Bun.serve({
    hostname,
    port,
    fetch: createTasqInspectorHandler(options),
  });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("Tasq inspector listener did not expose a bound port");
  }
  const urlHost = hostname === "::1" ? "[::1]" : hostname;
  return {
    hostname,
    port: server.port,
    url: `http://${urlHost}:${server.port}`,
    async stop() {
      await server.stop(true);
    },
  };
}
