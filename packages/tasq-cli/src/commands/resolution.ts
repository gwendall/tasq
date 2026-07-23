/** ADR-005/TQ-612 completion resolution CLI over the canonical service module. */

import { createHash } from "node:crypto";
import {
  adjudicateCompletion,
  attestCompletion,
  attestEvidenceTrust,
  challengeCompletion,
  createResolutionContract,
  getCompletionResolutionChain,
  localPrincipalId,
  proposeCompletion,
  revokeEvidenceTrust,
  settleOptimisticCompletion,
  type Metadata,
} from "@tasq-internal/local-service";
import {
  RESOLUTION_POLICY_KINDS,
  VALIDATION_OUTCOMES,
  type Clock,
  type ResolutionPolicyKind,
  type ValidationOutcome,
} from "@tasq-run/schema";
import { enumArg, type ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { RESOLUTION_USAGE } from "./usage.js";

function json<T>(raw: string | undefined, label: string): T {
  if (!raw) throw new Error(`--${label} is required`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`--${label} must be valid JSON`);
  }
}

function metadata(raw: string | undefined): Metadata {
  if (!raw) return {};
  const value = json<unknown>(raw, "metadata");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--metadata must be a JSON object");
  }
  return value as Metadata;
}

function csv(raw: string | undefined): string[] {
  return raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
}

function implementationDigest(policy: ResolutionPolicyKind, supplied?: string): string {
  if (supplied) return supplied;
  return `sha256:${createHash("sha256")
    .update(`tasq.local-resolution-policy.${policy}.v1`)
    .digest("hex")}`;
}

export async function resolutionCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const [sub, raw] = args.positional;
  if (!sub) {
    printError(RESOLUTION_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    if (sub === "contract") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const policyKind = enumArg<ResolutionPolicyKind>(
        args.string("policy"),
        RESOLUTION_POLICY_KINDS,
        "policy",
      );
      if (!policyKind) throw new Error("resolution contract requires --policy");
      const validatorIds = csv(args.string("validators"))
        .map((alias) => localPrincipalId(rt.config.tenantId, alias));
      const adjudicatorIds = csv(args.string("adjudicators"))
        .map((alias) => localPrincipalId(rt.config.tenantId, alias));
      const result = await createResolutionContract(rt.db, {
        taskId,
        criteria: json(args.string("criteria"), "criteria"),
        policyKind,
        policyUri: args.string("policy-uri") ?? `urn:tasq:completion-policy:${policyKind}`,
        policyVersion: args.number("policy-version") ?? 1,
        implementationDigest: implementationDigest(
          policyKind,
          args.string("implementation-digest"),
        ),
        notBefore: args.string("not-before")
          ? Date.parse(args.string("not-before")!)
          : null,
        challengeWindowMs: args.number("challenge-window-ms") ?? 0,
        allowSelfValidation: args.bool("allow-self-validation"),
        eligibleValidatorPrincipalIds: validatorIds,
        adjudicatorPrincipalIds: adjudicatorIds,
        metadata: metadata(args.string("metadata")),
      }, { ...rt.ctx, idempotencyKey: args.string("idempotency-key") });
      return output(args, result, `resolution contract ${shortId(result.id)} created`);
    }

    if (sub === "trust") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const evidenceId = args.string("evidence");
      if (!evidenceId) throw new Error("resolution trust requires --evidence");
      const result = await attestEvidenceTrust(rt.db, {
        taskId,
        evidenceId,
        authenticity: "unverified",
        authorityUri: "urn:tasq:authority:local-attribution",
        authorityVersion: 1,
        authorityDigest: implementationDigest("attestation"),
        reason: args.string("reason") ?? "Local actor attribution; source is unverified",
        verifiedAt: rt.ctx.clock.now(),
        validUntil: null,
        retentionUntil: args.string("retention-until")
          ? Date.parse(args.string("retention-until")!)
          : null,
      }, { ...rt.ctx, idempotencyKey: args.string("idempotency-key") });
      return output(args, result, `evidence trust ${shortId(result.id)} recorded`);
    }

    if (sub === "revoke-trust") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const reason = args.string("reason");
      if (!reason) throw new Error("resolution revoke-trust requires --reason");
      const result = await revokeEvidenceTrust(rt.db, raw, {
        ...rt.ctx,
        reason,
        idempotencyKey: args.string("idempotency-key"),
      });
      return output(args, result, `evidence trust ${shortId(result.id)} revoked`);
    }

    if (sub === "propose") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const contractId = args.string("contract");
      if (!contractId) throw new Error("resolution propose requires --contract");
      const result = await proposeCompletion(rt.db, {
        taskId,
        resolutionContractId: contractId,
        criterionEvidence: json(args.string("criterion-evidence"), "criterion-evidence"),
        summary: args.string("summary") ?? null,
      }, { ...rt.ctx, idempotencyKey: args.string("idempotency-key") });
      return output(args, result, `completion proposal ${shortId(result.id)} recorded`);
    }

    if (sub === "challenge") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const reasonCode = args.string("reason-code");
      const explanation = args.string("explanation");
      if (!reasonCode || !explanation) {
        throw new Error("resolution challenge requires --reason-code and --explanation");
      }
      const result = await challengeCompletion(rt.db, {
        proposalId: raw,
        reasonCode,
        explanation,
        counterEvidenceIds: csv(args.string("counter-evidence")),
      }, { ...rt.ctx, idempotencyKey: args.string("idempotency-key") });
      return output(args, result, `completion challenge ${shortId(result.id)} recorded`);
    }

    if (sub === "attest" || sub === "adjudicate") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const outcome = enumArg<ValidationOutcome>(
        args.string("outcome"),
        VALIDATION_OUTCOMES,
        "outcome",
      );
      const reasonCode = args.string("reason-code");
      const explanation = args.string("explanation");
      if (!outcome || !reasonCode || !explanation) {
        throw new Error(`resolution ${sub} requires --outcome, --reason-code and --explanation`);
      }
      const input = {
        proposalId: raw,
        outcome,
        reasonCode,
        explanation,
        supersedesDecisionId: args.string("supersedes") ?? null,
      };
      const result = sub === "attest"
        ? await attestCompletion(rt.db, input, {
          ...rt.ctx,
          idempotencyKey: args.string("idempotency-key"),
        })
        : await adjudicateCompletion(rt.db, input, {
          ...rt.ctx,
          idempotencyKey: args.string("idempotency-key"),
        });
      return output(args, result, `validation decision ${shortId(result.id)} → ${result.outcome}`);
    }

    if (sub === "settle") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const result = await settleOptimisticCompletion(rt.db, raw, {
        ...rt.ctx,
        idempotencyKey: args.string("idempotency-key"),
      });
      return output(args, result, `validation decision ${shortId(result.id)} → ${result.outcome}`);
    }

    if (sub === "show") {
      if (!raw) throw new Error(RESOLUTION_USAGE);
      const result = await getCompletionResolutionChain(rt.db, raw, rt.config.tenantId);
      if (!result) throw new Error(`resolution contract not found: ${raw}`);
      return output(args, result, `resolution contract ${shortId(result.contract.id)}`);
    }

    throw new Error(`Unknown resolution subcommand: ${sub}`);
  } finally {
    await rt.close();
  }
}

function output(args: ParsedArgs, value: unknown, message: string): number {
  if (args.bool("json", "j")) printJson(value);
  else printInfo(`${color.green("✓")} ${message}`);
  return 0;
}
