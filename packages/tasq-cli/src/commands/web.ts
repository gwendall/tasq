/** Local, unauthenticated and strictly read-only web inspection surface. */

import { CoordinationSpaceId, systemClock, type Clock } from "@tasq/schema";
import type { ParsedArgs } from "../args.js";
import { printInfo } from "../output/format.js";
import { openRuntime } from "../runtime.js";

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
): Promise<number> {
  if (args.positional.length > 0) throw new Error("Unexpected positional arguments for web");
  if (args.flag("json", "j") !== undefined) {
    throw new Error("--json is not accepted by web; this command serves HTTP until stopped");
  }
  const workspaceId = CoordinationSpaceId.parse(args.string("tenant"));
  const hostname = args.string("host") ?? "127.0.0.1";
  const port = parsePort(args.number("port"));

  // Keep browser-only code out of every ordinary one-shot CLI process.
  const { startTasqInspectorServer } = await import("@tasq/console");
  const rt = await openRuntime(undefined, workspaceId, clock, {
    installReferenceExtension: false,
  });
  let server: ReturnType<typeof startTasqInspectorServer> | undefined;
  try {
    server = startTasqInspectorServer({
      db: rt.db,
      workspaceId,
      clock: rt.ctx.clock,
      hostname,
      port,
      onError(error) {
        process.stderr.write(
          `tasq: inspector read failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    });
    printInfo(
      `Tasq inspector listening at ${server.url} for workspace ${JSON.stringify(workspaceId)}. ` +
      "Unauthenticated local read access; press Ctrl-C to stop.",
    );
    await waitForShutdown();
    return 0;
  } finally {
    // Stop accepting reads before closing their database dependency.
    if (server) await server.stop();
    await rt.close();
  }
}
