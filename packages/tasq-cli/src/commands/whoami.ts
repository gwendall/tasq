/**
 * `tasq whoami` — who this ledger thinks is writing, and what that is worth.
 *
 * The honest part matters as much as the identity. `--actor` is self-asserted,
 * and locally that is not a hole: anyone who can pass the flag can also open
 * the store directly. Printing an identity without saying what it proves would
 * be worse than printing nothing, because it would read as authentication.
 */

import {
  devicesForPrincipal,
  localPrincipalId,
  sharedPrincipals,
  shortFingerprint,
} from "@tasq-internal/local-service";
import type { Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { loadOrCreateDeviceIdentity } from "../identity.js";
import { color, printInfo, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";

export async function whoamiCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  if (args.positional.length > 0) throw new Error("whoami accepts flags only");
  const json = args.flag("json", "j") !== undefined;
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    const tenantId = rt.config.tenantId;
    const actor = rt.ctx.actor ?? "system";
    const principalId = localPrincipalId(tenantId, actor);
    const device = loadOrCreateDeviceIdentity(clock.now());
    const devices = await devicesForPrincipal(rt.db, tenantId, principalId);
    const shared = (await sharedPrincipals(rt.db, tenantId))
      .map((entry) => ({
        principalId: entry.principalId,
        fingerprints: entry.devices.map((d) => d.fingerprint),
      }));

    const result = {
      contractVersion: "tasq.whoami.v1",
      space: tenantId,
      actor,
      principalId,
      device: device
        ? { fingerprint: device.fingerprint, algorithm: device.algorithm, keyPath: device.path }
        : null,
      devicesSeenForThisPrincipal: devices.map((entry) => ({
        fingerprint: entry.fingerprint,
        thisDevice: entry.fingerprint === device?.fingerprint,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
      })),
      principalsUsedByMoreThanOneDevice: shared,
      // Said in the contract, not only in the prose, so an agent reading this
      // over --json cannot mistake attribution for authentication.
      actorAuthentication: "local_process_self_asserted",
      proves: "which installation wrote, once it has written",
      doesNotProve: "who the human is, or that the actor label was not chosen freely",
    };

    if (json) {
      printJson(result);
      return 0;
    }

    const lines = [
      `${color.bold(actor)} in ${color.bold(tenantId)}`,
      color.dim(`  principal  ${principalId}`),
    ];
    if (device) {
      lines.push(color.dim(`  device     ${shortFingerprint(device.fingerprint)}  (${device.algorithm})`));
    } else {
      lines.push(color.yellow("  device     none - this installation could not write a key"));
    }

    const others = devices.filter((entry) => entry.fingerprint !== device?.fingerprint);
    if (others.length > 0) {
      lines.push("");
      lines.push(color.yellow(`  ! ${others.length} other device(s) have written as ${actor} here:`));
      for (const entry of others) {
        const last = new Date(entry.lastSeenAt).toISOString().slice(0, 16).replace("T", " ");
        lines.push(color.dim(`      ${shortFingerprint(entry.fingerprint)}  last wrote ${last}`));
      }
      lines.push(color.dim("    The ledger cannot tell whether that is you on another machine"));
      lines.push(color.dim("    or somebody else using the same label. Only you can."));
    }

    lines.push("");
    lines.push(color.dim("  This is attribution, not authentication. The actor label is chosen"));
    lines.push(color.dim("  freely, and anyone who can run tasq here can also open the store"));
    lines.push(color.dim("  directly. What the device records is which installation wrote."));
    printInfo(lines.join("\n"));
    return 0;
  } finally {
    await rt.close();
  }
}
