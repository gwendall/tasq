import {
  ActionIdentity,
  AuthorizationReason,
  AuthorizationGrant,
  Delegation,
  GrantScope,
  definePermissionSet,
  digestAuthorityValue,
  getRegisteredAction,
  type AuthorizationDecision,
  type PermissionSetDefinition,
} from "@tasq-internal/authority";
import { z } from "zod";

export const MANDATE_CONTRACT_VERSION = "tasq.mandate-intent.v1" as const;
export const MANDATE_VIEW_CONTRACT_VERSION = "tasq.mandate-view.v1" as const;
export const MANDATE_DECISION_CONTRACT_VERSION = "tasq.mandate-decision.v1" as const;

const Id = z.string().min(1).max(400)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Generic usage and money limits are intentionally explicit, even though the
 * only safe value in v1 is null. Tasq does not pretend that an unevaluated JSON
 * field is an enforced budget. Effect-specific limits remain in the existing
 * approval ledger and dispatch gate.
 */
export const MandateConstraints = z.object({
  maxOperations: z.null(),
  budget: z.null(),
}).strict();
export type MandateConstraints = z.infer<typeof MandateConstraints>;

export const MandateIntent = z.object({
  contractVersion: z.literal(MANDATE_CONTRACT_VERSION),
  id: Id,
  workspaceId: WorkspaceId,
  grantorPrincipalId: Id,
  subjectPrincipalId: Id,
  actorPrincipalId: Id.nullable(),
  actions: z.array(ActionIdentity).min(1).max(21),
  target: GrantScope,
  notBefore: UnixMs.nullable(),
  expiresAt: UnixMs.nullable(),
  constraints: MandateConstraints,
}).strict().superRefine((value, ctx) => {
  const uris = value.actions.map(({ uri }) => uri);
  if (uris.some((uri, index) => index > 0 && uris[index - 1]! >= uri)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "actions must be sorted and unique" });
  }
  if (value.actorPrincipalId === value.subjectPrincipalId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actorPrincipalId"], message: "actor must differ from subject" });
  }
  if (value.notBefore !== null && value.expiresAt !== null && value.notBefore >= value.expiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiry must follow notBefore" });
  }
});
export type MandateIntent = z.infer<typeof MandateIntent>;

export const MandateCompileDenial = z.enum([
  "unknown_action",
  "action_identity_mismatch",
  "action_target_mismatch",
  "generic_usage_limit_unsupported",
  "generic_budget_unsupported",
  "remote_effect_dispatch_disabled",
]);
export type MandateCompileDenial = z.infer<typeof MandateCompileDenial>;

export class MandateCompileError extends Error {
  constructor(readonly code: MandateCompileDenial, message: string) {
    super(message);
    this.name = "MandateCompileError";
  }
}

export interface CompiledMandate {
  intent: MandateIntent;
  permissionSet: PermissionSetDefinition;
  subjectGrant: AuthorizationGrant;
  actorGrant: AuthorizationGrant | null;
  delegation: Delegation | null;
}

export function mandateRecordIds(workspaceId: string, mandateId: string) {
  const key = digestAuthorityValue({ workspaceId, mandateId }).slice("sha256:".length);
  return {
    permissionUri: `urn:tasq:mandate:${key}`,
    subjectGrantId: `mandate:${mandateId}:subject`,
    actorGrantId: `mandate:${mandateId}:actor`,
    delegationId: `mandate:${mandateId}:delegation`,
  } as const;
}

export function compileMandate(input: unknown): CompiledMandate {
  const proposed = input as { constraints?: { maxOperations?: unknown; budget?: unknown } };
  if (proposed?.constraints?.maxOperations !== null) {
    throw new MandateCompileError("generic_usage_limit_unsupported", "generic use counters are not enforced by authority v1");
  }
  if (proposed?.constraints?.budget !== null) {
    throw new MandateCompileError("generic_budget_unsupported", "generic budgets require an enforcing ledger; use effect approval limits");
  }
  const intent = MandateIntent.parse(input);
  for (const identity of intent.actions) {
    const action = getRegisteredAction(identity.uri);
    if (!action) throw new MandateCompileError("unknown_action", `unknown action ${identity.uri}`);
    if (action.version !== identity.version || action.implementationDigest !== identity.implementationDigest) {
      throw new MandateCompileError("action_identity_mismatch", `stale or conflicting action identity ${identity.uri}`);
    }
    if (identity.uri === "urn:tasq:action:effect.dispatch") {
      throw new MandateCompileError("remote_effect_dispatch_disabled", "remote effect dispatch remains disabled through TQ-906");
    }
    if (intent.target.kind === "exact" && !action.resourceKinds.includes(intent.target.resource.kind)) {
      throw new MandateCompileError("action_target_mismatch", `${identity.uri} does not accept ${intent.target.resource.kind} targets`);
    }
  }
  const ids = mandateRecordIds(intent.workspaceId, intent.id);
  const actionDefinitions = intent.actions.map((identity) => getRegisteredAction(identity.uri)!);
  const permissionSet = definePermissionSet({ uri: ids.permissionUri, version: 1, actions: actionDefinitions });
  const grant = (id: string, granteePrincipalId: string): AuthorizationGrant => AuthorizationGrant.parse({
    contractVersion: "tasq.authorization-grant.v1",
    id,
    workspaceId: intent.workspaceId,
    grantorPrincipalId: intent.grantorPrincipalId,
    granteePrincipalId,
    permissionSet: {
      uri: permissionSet.uri,
      version: permissionSet.version,
      implementationDigest: permissionSet.implementationDigest,
    },
    scope: intent.target,
    notBefore: intent.notBefore,
    expiresAt: intent.expiresAt,
    status: "active",
    revision: 1,
  });
  const subjectGrant = grant(ids.subjectGrantId, intent.subjectPrincipalId);
  const actorGrant = intent.actorPrincipalId === null ? null : grant(ids.actorGrantId, intent.actorPrincipalId);
  const delegation = intent.actorPrincipalId === null ? null : Delegation.parse({
    contractVersion: "tasq.delegation.v1",
    id: ids.delegationId,
    workspaceId: intent.workspaceId,
    subjectPrincipalId: intent.subjectPrincipalId,
    actorPrincipalId: intent.actorPrincipalId,
    actions: intent.actions,
    scope: intent.target,
    notBefore: intent.notBefore,
    expiresAt: intent.expiresAt,
    status: "active",
    revision: 1,
  });
  return { intent, permissionSet, subjectGrant, actorGrant, delegation };
}

export const MandateView = z.object({
  contractVersion: z.literal(MANDATE_VIEW_CONTRACT_VERSION),
  intent: MandateIntent,
  status: z.enum(["active", "revoked"]),
  revision: z.number().int().positive(),
  authorityRevision: z.number().int().nonnegative(),
  compiledRecordIds: z.object({
    permissionUri: z.string(),
    subjectGrantId: z.string(),
    actorGrantId: z.string().nullable(),
    delegationId: z.string().nullable(),
  }).strict(),
  assurance: z.object({
    secondAuthorityRecordCreated: z.literal(false),
    genericUsageLimitEnforced: z.literal(false),
    genericBudgetEnforced: z.literal(false),
    remoteEffectDispatchEnabled: z.literal(false),
  }).strict(),
}).strict();
export type MandateView = z.infer<typeof MandateView>;

export const MandateDecisionReason = z.union([
  z.enum(["mandate_not_found", "mandate_revoked", "mandate_action_denied", "mandate_target_denied", "mandate_not_supporting_decision", "remote_effect_dispatch_disabled"]),
  AuthorizationReason,
]);

export const MandateDecision = z.object({
  contractVersion: z.literal(MANDATE_DECISION_CONTRACT_VERSION),
  mandateId: Id,
  requestId: Id,
  evaluatedAt: UnixMs,
  actionUri: z.string().url().or(z.string().startsWith("urn:")),
  resourceKind: z.string(),
  resourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  decision: z.enum(["allow", "deny"]),
  reasonCode: MandateDecisionReason,
  authorityDecisionId: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  authorityRevision: z.number().int().nonnegative().nullable(),
  remoteEffectDispatchEnabled: z.literal(false),
}).strict();
export type MandateDecision = z.infer<typeof MandateDecision>;

export function protectedMandateDecision(input: {
  mandateId: string;
  requestId: string;
  actionUri: string;
  resource: { kind: string; id: string };
  evaluatedAt: number;
  decision: "allow" | "deny";
  reasonCode: string;
  authorityDecision?: AuthorizationDecision | null;
  authorityRevision?: number | null;
}): MandateDecision {
  return MandateDecision.parse({
    contractVersion: MANDATE_DECISION_CONTRACT_VERSION,
    mandateId: input.mandateId,
    requestId: input.requestId,
    evaluatedAt: input.evaluatedAt,
    actionUri: input.actionUri,
    resourceKind: input.resource.kind,
    resourceDigest: digestAuthorityValue({ kind: input.resource.kind, id: input.resource.id }),
    decision: input.decision,
    reasonCode: input.reasonCode,
    authorityDecisionId: input.authorityDecision?.decisionId ?? null,
    authorityRevision: input.authorityRevision ?? null,
    remoteEffectDispatchEnabled: false,
  });
}
