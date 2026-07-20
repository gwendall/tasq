import {
  attachExternalContextLink,
  detachExternalContextLink,
  getExternalContextLink,
  listExternalContextLinks,
  type Clock,
} from "@tasq-internal/local-service";
import {
  DEFAULT_EXTERNAL_CONTEXT_PURPOSE_URI,
  EXTERNAL_CONTEXT_LINK_PAGE_CONTRACT_VERSION,
} from "@tasq/schema";
import type { ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { CONTEXT_LINK_USAGE } from "./usage.js";

export async function contextLinkCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const action = args.positional[0];
  if (!action || !["attach", "detach", "list", "show"].includes(action)) {
    printError(CONTEXT_LINK_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    if (action === "show") {
      const id = args.positional[1];
      if (!id) { printError(CONTEXT_LINK_USAGE); return 1; }
      const item = await getExternalContextLink(rt.db, id, rt.config.tenantId);
      if (!item) { printError(`context link not found: ${id}`); return 1; }
      if (args.bool("json", "j")) printJson(item);
      else printInfo(`${color.bold(item.state)} ${item.target.system} ${item.target.externalId}\n${color.dim(item.id)}`);
      return 0;
    }

    if (action === "detach") {
      const id = args.positional[1];
      const idempotencyKey = args.string("idempotency-key");
      if (!id || !idempotencyKey) { printError(CONTEXT_LINK_USAGE); return 1; }
      const item = await detachExternalContextLink(rt.db, {
        workspaceId: rt.config.tenantId,
        expectedPreviousLinkId: id,
      }, {
        actor: rt.ctx.actor,
        principalId: rt.ctx.principalId,
        idempotencyKey,
        clock,
      });
      if (args.bool("json", "j")) printJson(item);
      else printInfo(`${color.green("context link detached")} ${color.dim(item.id)}`);
      return 0;
    }

    const commitmentArg = args.positional[1];
    if (!commitmentArg) { printError(CONTEXT_LINK_USAGE); return 1; }
    const commitmentId = await resolveTaskIdOrError(rt, commitmentArg, "commitment");
    if (!commitmentId) return 1;

    if (action === "list") {
      const history = args.bool("history");
      const items = await listExternalContextLinks(rt.db, {
        workspaceId: rt.config.tenantId,
        commitmentId,
        currentOnly: !history,
        limit: args.number("limit"),
      });
      const page = {
        contractVersion: EXTERNAL_CONTEXT_LINK_PAGE_CONTRACT_VERSION,
        items,
        ...(!history ? { selection: {
          mode: "current_active" as const,
          excludes: ["detached", "superseded"] as const,
          emptyDoesNotProveNoHistory: true as const,
          historyRecipeId: "context-link.history" as const,
        } } : {}),
      };
      if (args.bool("json", "j")) printJson(page);
      else if (items.length === 0) printInfo(color.dim(
        history ? "(no context-link history)" : "(no active context links; pass --history to inspect old links)",
      ));
      else for (const item of items) {
        printInfo(`${color.dim(shortId(item.id))}  ${item.state.padEnd(10)}  ${item.binding.padEnd(8)}  ${item.target.system} ${item.target.externalId}`);
      }
      return 0;
    }

    const system = args.string("system");
    const resourceType = args.string("resource-type");
    const externalId = args.string("external-id");
    const idempotencyKey = args.string("idempotency-key");
    if (!system || !resourceType || !externalId || !idempotencyKey) {
      printError(CONTEXT_LINK_USAGE);
      return 1;
    }
    const item = await attachExternalContextLink(rt.db, {
      workspaceId: rt.config.tenantId,
      commitmentId,
      purposeUri: args.string("purpose") ?? DEFAULT_EXTERNAL_CONTEXT_PURPOSE_URI,
      target: {
        system,
        resourceType,
        externalId,
        url: args.string("url") ?? null,
        version: args.string("version") ?? null,
        digest: args.string("digest") ?? null,
      },
      expectedPreviousLinkId: args.string("supersedes") ?? null,
    }, {
      actor: rt.ctx.actor,
      principalId: rt.ctx.principalId,
      idempotencyKey,
      clock,
    });
    if (args.bool("json", "j")) printJson(item);
    else printInfo(`${color.green("context link attached")} ${color.dim(item.id)} (${item.binding})`);
    return 0;
  } finally {
    await rt.close();
  }
}
