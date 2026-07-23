/** Local, unauthenticated and strictly read-only web inspection surface. */

import { CoordinationSpaceId, systemClock, type Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { printInfo, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import {
  discoverConsole,
  prepareConsoleRegistration,
  registerConsole,
  unregisterConsole,
} from "../console-lifecycle.js";

function parsePort(value: number | undefined): number {
  const port = value ?? 4_137;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return port;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function webCmd(
  args: ParsedArgs,
  clock: Clock = systemClock,
  waitForShutdown: () => Promise<void> = waitForShutdownSignal,
  productVersion = "0.1.0",
): Promise<number> {
  const workspaceId = CoordinationSpaceId.parse(args.string("tenant"));
  const subcommand = args.positional[0];
  if (args.positional.length > 1 || (subcommand !== undefined && subcommand !== "status")) {
    throw new Error("Expected `web` or `web status`");
  }
  const machine = args.bool("json", "j");
  if (subcommand === "status") {
    const discovery = await discoverConsole(workspaceId);
    if (machine) printJson(discovery);
    else if (discovery.state === "running") {
      printInfo(`Tasq Console is running at ${discovery.descriptor!.endpoint.url} for workspace ${JSON.stringify(workspaceId)}.`);
    } else {
      printInfo(`Tasq Console is ${discovery.state} for workspace ${JSON.stringify(workspaceId)} (${discovery.reason}).`);
    }
    return discovery.state === "running" ? 0 : 1;
  }
  const hostname = args.string("host") ?? "127.0.0.1";
  const port = parsePort(args.number("port"));

  // Keep browser-only code out of every ordinary one-shot CLI process.
  const { assertLoopbackHost, startTasqInspectorServer } = await import("@tasq-run/console");
  const loopbackHostname = assertLoopbackHost(hostname);
  await prepareConsoleRegistration(workspaceId);
  const rt = await openRuntime(undefined, workspaceId, clock, {
    installReferenceExtension: false,
  });
  let server: ReturnType<typeof startTasqInspectorServer> | undefined;
  let registered = false;
  try {
    server = startTasqInspectorServer({
      db: rt.db,
      workspaceId,
      clock: rt.ctx.clock,
      hostname: loopbackHostname,
      port,
      productVersion,
      onError(error) {
        process.stderr.write(
          `tasq: Console read failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    });
    try {
      await registerConsole(server.descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await discoverConsole(workspaceId);
      if (current.state === "running") {
        throw new Error(`Console is already registered at ${current.descriptor!.endpoint.url}`);
      }
      throw new Error(`Console registration changed during startup; run tasq web status --tenant ${JSON.stringify(workspaceId)}`);
    }
    registered = true;
    if (machine) process.stdout.write(`${JSON.stringify(server.descriptor)}\n`);
    else printInfo(
      `Tasq Console listening at ${server.url} for workspace ${JSON.stringify(workspaceId)}. ` +
      "Foreground, unauthenticated local read access; press Ctrl-C to stop.",
    );
    await waitForShutdown();
    return 0;
  } finally {
    // Stop accepting reads before closing their database dependency.
    try {
      if (server) await server.stop();
    } finally {
      try {
        if (server && registered) await unregisterConsole(server.descriptor);
      } finally {
        await rt.close();
      }
    }
  }
}
