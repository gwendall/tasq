/** Read-only inspection of accepted signed proof. Signing and acceptance remain host-owned. */
import {
  getSignedStatementProof,
  listSignedStatementBindings,
} from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { printError, printInfo, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";

const USAGE = "signature show <statement-id> | signature bindings [record-id]";

export async function signatureCmd(args: ParsedArgs): Promise<number> {
  const [sub, id] = args.positional;
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (sub === "show") {
      if (!id) throw new Error(USAGE);
      const proof = await getSignedStatementProof(rt.db, id, rt.config.tenantId);
      if (!proof) {
        printError(`signed statement not found: ${id}`);
        return 1;
      }
      printJson(proof);
      return 0;
    }
    if (sub === "bindings") {
      const bindings = await listSignedStatementBindings(rt.db, {
        tenantId: rt.config.tenantId,
        ...(id ? { recordId: id } : {}),
      });
      if (args.bool("json", "j")) printJson(bindings);
      else for (const binding of bindings) {
        printInfo(`${binding.bindingKind}  ${binding.recordType}:${binding.recordId}  statement:${binding.statementId}`);
      }
      return 0;
    }
    throw new Error(USAGE);
  } finally {
    await rt.close();
  }
}
