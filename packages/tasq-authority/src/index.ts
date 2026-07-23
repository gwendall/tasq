/**
 * TQ-801 pure hosted-authority foundation.
 *
 * Authentication adapters verify credentials before constructing these
 * values. Persistence, HTTP, OIDC/JWKS, sessions and the Tasq kernel remain
 * outside this package.
 */

import { createHash } from "node:crypto";
import type { Clock } from "@tasq-run/schema";
import { z } from "zod";

export const VERIFIED_IDENTITY_CONTRACT_VERSION = "tasq.verified-identity.v1" as const;
export const AUTHORIZATION_REQUEST_CONTRACT_VERSION = "tasq.authorization-request.v1" as const;
export const AUTHORIZATION_DECISION_CONTRACT_VERSION = "tasq.authorization-decision.v1" as const;
export const AUTHORIZATION_POLICY_ID = "urn:tasq:policy:reference-authorizer:v1" as const;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const OpaqueId = z.string().min(1).max(500).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), {
  message: "identity must be trimmed and contain no control characters",
});
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);

function absoluteUri(value: string): boolean {
  if (value.includes("*")) return false;
  try {
    const parsed = new URL(value);
    return parsed.href === value && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

const AbsoluteUri = z.string().min(1).max(500).refine(absoluteUri, "must be one canonical absolute URI without wildcards");
const HttpsIssuer = AbsoluteUri.refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.search === "" && parsed.hash === "";
}, "issuer must be a canonical HTTPS URI without query or fragment");

function sortedUnique(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("authority canonical JSON accepts safe integers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new Error("authority canonical JSON accepts portable JSON only");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

/** Canonical portable-JSON digest shared by authority persistence adapters. */
export function digestAuthorityValue(value: unknown): string {
  return digest(value);
}

export const ResourceKind = z.enum(["workspace", "commitment", "resource", "effect", "replica"]);
export type ResourceKind = z.infer<typeof ResourceKind>;

export const ResourceRef = z.object({
  kind: ResourceKind,
  id: OpaqueId,
}).strict();
export type ResourceRef = z.infer<typeof ResourceRef>;

const ActionDefinitionShape = z.object({
  uri: AbsoluteUri,
  version: z.literal(1),
  implementationDigest: Digest,
  resourceKinds: z.array(ResourceKind).min(1).max(5),
  senderConstraint: z.enum(["none", "required"]),
  eligibility: z.enum(["none", "effect_approver", "effect_connector"]),
}).strict();
export type ActionDefinition = z.infer<typeof ActionDefinitionShape>;

const rawActions = [
  ["workspace.read", ["workspace"], "none", "none"],
  ["workspace.admin", ["workspace"], "required", "none"],
  ["commitment.read", ["commitment"], "none", "none"],
  ["commitment.propose", ["workspace"], "none", "none"],
  ["commitment.mutate", ["commitment"], "none", "none"],
  ["claim.coordinate", ["commitment"], "none", "none"],
  ["attempt.execute", ["commitment"], "none", "none"],
  ["evidence.append", ["commitment"], "none", "none"],
  ["resource.coordinate", ["resource"], "none", "none"],
  ["collaboration.assign", ["commitment"], "none", "none"],
  ["effect.propose", ["effect"], "none", "none"],
  ["effect.approval.record", ["effect"], "required", "effect_approver"],
  ["effect.dispatch", ["effect"], "required", "effect_connector"],
  ["replication.enroll", ["workspace", "replica"], "required", "none"],
  ["replication.push", ["replica"], "required", "none"],
  ["replication.pull", ["replica"], "none", "none"],
] as const;

function actionDefinition(entry: (typeof rawActions)[number]): ActionDefinition {
  const [name, resourceKinds, senderConstraint, eligibility] = entry;
  const identity = {
    uri: `urn:tasq:action:${name}`,
    version: 1 as const,
    resourceKinds: [...resourceKinds],
    senderConstraint,
    eligibility,
  };
  const parsed = ActionDefinitionShape.parse({
    ...identity,
    implementationDigest: digest(identity),
  });
  Object.freeze(parsed.resourceKinds);
  return Object.freeze(parsed);
}

export const ACTION_REGISTRY: readonly ActionDefinition[] = Object.freeze(rawActions.map(actionDefinition));
export const ACTION_URIS = Object.freeze(Object.fromEntries(
  ACTION_REGISTRY.map((action) => [action.uri.slice("urn:tasq:action:".length), action.uri]),
)) as Readonly<Record<(typeof rawActions)[number][0], string>>;

const registryByUri = new Map(ACTION_REGISTRY.map((action) => [action.uri, action]));
export const AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST = digest({
  policy: AUTHORIZATION_POLICY_ID,
  contractVersions: [
    VERIFIED_IDENTITY_CONTRACT_VERSION,
    AUTHORIZATION_REQUEST_CONTRACT_VERSION,
    AUTHORIZATION_DECISION_CONTRACT_VERSION,
  ],
  actions: ACTION_REGISTRY,
  decision: "deny_by_default_complete_canonical_snapshot_digest",
  clock: "required_injection_one_capture_per_decision",
  validity: "authenticated_and_not_before_inclusive_expires_at_exclusive",
  binding: "exact_workspace_issuer_subject_enabled_principal_after_creation",
  token: "exact_audience_sender_binding_and_registered_action_upper_bound",
  grants: "allow_only_live_scoped_immutable_permission_set",
  delegation: "subject_grant_actor_grant_and_exact_live_delegation_intersection",
  effects: "grant_plus_separate_approver_or_service_connector_eligibility",
});

export function getRegisteredAction(uri: string): ActionDefinition | null {
  return registryByUri.get(uri) ?? null;
}

export const ActionIdentity = z.object({
  uri: AbsoluteUri,
  version: z.number().int().positive(),
  implementationDigest: Digest,
}).strict();
export type ActionIdentity = z.infer<typeof ActionIdentity>;

const CredentialBinding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("dpop"), keyThumbprintDigest: Digest }).strict(),
  z.object({ kind: z.literal("mtls_spiffe"), identityUri: AbsoluteUri, certificateThumbprintDigest: Digest }).strict(),
]);

const ActorSubject = z.object({ issuer: HttpsIssuer, subject: OpaqueId }).strict();

export const VerifiedIdentity = z.object({
  contractVersion: z.literal(VERIFIED_IDENTITY_CONTRACT_VERSION),
  issuer: HttpsIssuer,
  subject: OpaqueId,
  audience: z.array(AbsoluteUri).min(1).max(16),
  authenticationMethod: z.enum(["oauth_jwt_access_token", "oauth_introspection", "spiffe_svid"]),
  authenticatedAt: UnixMs,
  notBefore: UnixMs.nullable(),
  expiresAt: UnixMs,
  clientId: OpaqueId.nullable(),
  actor: ActorSubject.nullable(),
  credentialBinding: CredentialBinding,
  tokenIdDigest: Digest.nullable(),
  issuerConfigurationDigest: Digest,
  credentialKeyDigest: Digest,
  actionUpperBound: z.array(ActionIdentity).max(ACTION_REGISTRY.length),
}).strict().superRefine((value, ctx) => {
  if (!sortedUnique(value.audience)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audience"], message: "audience must be sorted and unique" });
  const actions = value.actionUpperBound.map(({ uri }) => uri);
  if (!sortedUnique(actions)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actionUpperBound"], message: "action upper bound must be sorted and unique" });
  for (const [index, identity] of value.actionUpperBound.entries()) {
    const registered = getRegisteredAction(identity.uri);
    if (!registered || !exactAction(identity, registered)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actionUpperBound", index], message: "action upper bound must use an exact registered action identity" });
    }
  }
  if (value.notBefore !== null && value.notBefore > value.authenticatedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notBefore"], message: "notBefore cannot follow authentication" });
  }
  if (value.authenticatedAt >= value.expiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "identity expiry must follow authentication" });
  }
  if (value.authenticationMethod === "spiffe_svid" && value.credentialBinding.kind !== "mtls_spiffe") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["credentialBinding"], message: "SPIFFE identity requires mTLS/SPIFFE binding" });
  }
});
export type VerifiedIdentity = z.infer<typeof VerifiedIdentity>;

export const SubjectBinding = z.object({
  contractVersion: z.literal("tasq.subject-binding.v1"),
  id: OpaqueId,
  workspaceId: WorkspaceId,
  principalId: OpaqueId,
  issuer: HttpsIssuer,
  subject: OpaqueId,
  method: z.union([z.enum(["oidc", "oauth_introspection", "spiffe"]), AbsoluteUri]),
  status: z.enum(["enabled", "disabled"]),
  revision: Revision,
  createdAt: UnixMs,
  disabledAt: UnixMs.nullable(),
  replacedByBindingId: OpaqueId.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === "enabled") !== (value.disabledAt === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["disabledAt"], message: "binding status and disabledAt must agree" });
  }
  if (value.disabledAt !== null && value.disabledAt < value.createdAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["disabledAt"], message: "binding cannot be disabled before creation" });
  }
  if (value.replacedByBindingId === value.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["replacedByBindingId"], message: "binding cannot replace itself" });
  }
});
export type SubjectBinding = z.infer<typeof SubjectBinding>;

export const AuthorityPrincipal = z.object({
  id: OpaqueId,
  workspaceId: WorkspaceId,
  kind: z.enum(["human", "agent", "service", "runtime"]),
  status: z.enum(["enabled", "disabled"]),
  revision: Revision,
}).strict();
export type AuthorityPrincipal = z.infer<typeof AuthorityPrincipal>;

export const PermissionSetDefinition = z.object({
  uri: AbsoluteUri,
  version: z.number().int().positive(),
  implementationDigest: Digest,
  actions: z.array(ActionIdentity).min(1).max(ACTION_REGISTRY.length),
}).strict().superRefine((value, ctx) => {
  if (!sortedUnique(value.actions.map(({ uri }) => uri))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "permission actions must be sorted and unique" });
  }
});
export type PermissionSetDefinition = z.infer<typeof PermissionSetDefinition>;

export const GrantScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("exact"), resource: ResourceRef }).strict(),
]);
export type GrantScope = z.infer<typeof GrantScope>;

export const AuthorizationGrant = z.object({
  contractVersion: z.literal("tasq.authorization-grant.v1"),
  id: OpaqueId,
  workspaceId: WorkspaceId,
  grantorPrincipalId: OpaqueId,
  granteePrincipalId: OpaqueId,
  permissionSet: z.object({ uri: AbsoluteUri, version: z.number().int().positive(), implementationDigest: Digest }).strict(),
  scope: GrantScope,
  notBefore: UnixMs.nullable(),
  expiresAt: UnixMs.nullable(),
  status: z.enum(["active", "revoked"]),
  revision: Revision,
}).strict().superRefine((value, ctx) => {
  if (value.notBefore !== null && value.expiresAt !== null && value.notBefore >= value.expiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "grant expiry must follow notBefore" });
  }
});
export type AuthorizationGrant = z.infer<typeof AuthorizationGrant>;

export const Delegation = z.object({
  contractVersion: z.literal("tasq.delegation.v1"),
  id: OpaqueId,
  workspaceId: WorkspaceId,
  subjectPrincipalId: OpaqueId,
  actorPrincipalId: OpaqueId,
  actions: z.array(ActionIdentity).min(1).max(ACTION_REGISTRY.length),
  scope: GrantScope,
  notBefore: UnixMs.nullable(),
  expiresAt: UnixMs.nullable(),
  status: z.enum(["active", "revoked"]),
  revision: Revision,
}).strict().superRefine((value, ctx) => {
  if (!sortedUnique(value.actions.map(({ uri }) => uri))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "delegated actions must be sorted and unique" });
  }
  for (const [index, identity] of value.actions.entries()) {
    const registered = getRegisteredAction(identity.uri);
    if (!registered || !exactAction(identity, registered)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions", index], message: "delegation must use an exact registered action identity" });
    }
  }
  if (value.subjectPrincipalId === value.actorPrincipalId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actorPrincipalId"], message: "delegation requires distinct subject and actor" });
  }
  if (value.notBefore !== null && value.expiresAt !== null && value.notBefore >= value.expiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "delegation expiry must follow notBefore" });
  }
});
export type Delegation = z.infer<typeof Delegation>;

export const AuthorityEligibility = z.object({
  contractVersion: z.literal("tasq.authority-eligibility.v1"),
  id: OpaqueId,
  workspaceId: WorkspaceId,
  principalId: OpaqueId,
  kind: z.enum(["effect_approver", "effect_connector"]),
  status: z.enum(["active", "revoked"]),
  notBefore: UnixMs.nullable(),
  expiresAt: UnixMs.nullable(),
  revision: Revision,
}).strict().superRefine((value, ctx) => {
  if (value.notBefore !== null && value.expiresAt !== null && value.notBefore >= value.expiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "eligibility expiry must follow notBefore" });
  }
});
export type AuthorityEligibility = z.infer<typeof AuthorityEligibility>;

const BoundPrincipal = z.object({ binding: SubjectBinding, principal: AuthorityPrincipal }).strict();

export const AuthorizationRequest = z.object({
  contractVersion: z.literal(AUTHORIZATION_REQUEST_CONTRACT_VERSION),
  requestId: OpaqueId,
  workspaceId: WorkspaceId,
  serviceAudience: AbsoluteUri,
  action: ActionIdentity,
  resource: ResourceRef,
  identity: VerifiedIdentity,
  subject: BoundPrincipal.nullable(),
  actor: BoundPrincipal.nullable(),
  permissionSets: z.array(PermissionSetDefinition).max(100),
  subjectGrants: z.array(AuthorizationGrant).max(100),
  actorGrants: z.array(AuthorizationGrant).max(100),
  delegation: Delegation.nullable(),
  eligibilities: z.array(AuthorityEligibility).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.resource.kind === "workspace" && value.resource.id !== value.workspaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resource", "id"], message: "workspace resource must match request workspace" });
  }
});
export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>;

export const AuthorizationReason = z.enum([
  "allowed",
  "unknown_action",
  "action_identity_mismatch",
  "action_resource_mismatch",
  "service_audience_mismatch",
  "identity_not_yet_valid",
  "identity_expired",
  "membership_required",
  "subject_binding_mismatch",
  "subject_binding_not_yet_valid",
  "subject_binding_disabled",
  "subject_principal_disabled",
  "actor_binding_required",
  "actor_binding_mismatch",
  "actor_binding_not_yet_valid",
  "actor_binding_disabled",
  "actor_principal_disabled",
  "sender_constraint_required",
  "token_upper_bound_denied",
  "authority_snapshot_invalid",
  "subject_grant_denied",
  "actor_grant_denied",
  "delegation_denied",
  "effect_eligibility_required",
]);
export type AuthorizationReason = z.infer<typeof AuthorizationReason>;

export const AuthorizationDecision = z.object({
  contractVersion: z.literal(AUTHORIZATION_DECISION_CONTRACT_VERSION),
  decisionId: Digest,
  requestId: OpaqueId,
  workspaceId: WorkspaceId,
  evaluatedAt: UnixMs,
  subjectPrincipalId: OpaqueId.nullable(),
  actorPrincipalId: OpaqueId.nullable(),
  actionUri: AbsoluteUri,
  resourceKind: ResourceKind,
  resourceId: OpaqueId,
  decision: z.enum(["allow", "deny"]),
  reasonCode: AuthorizationReason,
  grantIds: z.array(OpaqueId).max(2),
  permissionSetDigests: z.array(Digest).max(2),
  policyImplementationDigest: Digest,
  requestDigest: Digest,
}).strict().superRefine((value, ctx) => {
  if ((value.decision === "allow") !== (value.reasonCode === "allowed")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "only allowed decisions use the allowed reason" });
  }
  if (value.decision === "deny" && (value.grantIds.length > 0 || value.permissionSetDigests.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["grantIds"], message: "denials do not claim supporting authority" });
  }
});
export type AuthorizationDecision = z.infer<typeof AuthorizationDecision>;

function exactAction(identity: ActionIdentity, definition: ActionDefinition): boolean {
  return identity.uri === definition.uri && identity.version === definition.version &&
    identity.implementationDigest === definition.implementationDigest;
}

function live(value: { status: string; notBefore: number | null; expiresAt: number | null }, now: number): boolean {
  return value.status === "active" && (value.notBefore === null || value.notBefore <= now) &&
    (value.expiresAt === null || now < value.expiresAt);
}

function covers(scope: GrantScope, resource: ResourceRef): boolean {
  return scope.kind === "workspace" || (scope.resource.kind === resource.kind && scope.resource.id === resource.id);
}

type Support = { grantId: string; permissionDigest: string };

function authoritySnapshot(
  request: AuthorizationRequest,
): { definitions: Map<string, PermissionSetDefinition>; valid: boolean } {
  const definitions = new Map<string, PermissionSetDefinition>();
  let valid = true;
  for (const definition of request.permissionSets) {
    const key = `${definition.uri}\u0000${definition.version}`;
    if (definitions.has(key)) valid = false;
    const semantic = { uri: definition.uri, version: definition.version, actions: definition.actions };
    if (digest(semantic) !== definition.implementationDigest) valid = false;
    for (const identity of definition.actions) {
      const registered = getRegisteredAction(identity.uri);
      if (!registered || !exactAction(identity, registered)) valid = false;
    }
    definitions.set(key, definition);
  }
  const allGrants = [...request.subjectGrants, ...request.actorGrants];
  if (new Set(allGrants.map(({ id }) => id)).size !== allGrants.length) valid = false;
  for (const grant of allGrants) {
    const definition = definitions.get(`${grant.permissionSet.uri}\u0000${grant.permissionSet.version}`);
    if (!definition || definition.implementationDigest !== grant.permissionSet.implementationDigest) valid = false;
  }
  const eligibilityIds = request.eligibilities.map(({ id }) => id);
  if (new Set(eligibilityIds).size !== eligibilityIds.length) valid = false;
  return { definitions, valid };
}

function supportingGrant(
  grants: AuthorizationGrant[],
  principalId: string,
  request: AuthorizationRequest,
  action: ActionDefinition,
  definitions: Map<string, PermissionSetDefinition>,
  now: number,
): Support | null {
  const matches = grants.filter((grant) => {
    if (grant.workspaceId !== request.workspaceId || grant.granteePrincipalId !== principalId || !live(grant, now) || !covers(grant.scope, request.resource)) return false;
    const definition = definitions.get(`${grant.permissionSet.uri}\u0000${grant.permissionSet.version}`);
    return definition?.implementationDigest === grant.permissionSet.implementationDigest &&
      definition.actions.some((identity) => exactAction(identity, action));
  }).sort((a, b) => a.id.localeCompare(b.id));
  const match = matches[0];
  return match ? { grantId: match.id, permissionDigest: match.permissionSet.implementationDigest } : null;
}

function bindingMatches(bound: z.infer<typeof BoundPrincipal>, workspaceId: string, issuer: string, subject: string): boolean {
  return bound.binding.workspaceId === workspaceId && bound.principal.workspaceId === workspaceId &&
    bound.binding.principalId === bound.principal.id && bound.binding.issuer === issuer && bound.binding.subject === subject;
}

function nowFrom(clock: Clock): number {
  if (!clock || typeof clock.now !== "function") throw new Error("authorization requires an injected Clock");
  return UnixMs.parse(clock.now());
}

function canonicalRequestSnapshot(request: AuthorizationRequest): AuthorizationRequest {
  return {
    ...request,
    permissionSets: [...request.permissionSets].sort((a, b) =>
      a.uri.localeCompare(b.uri) || a.version - b.version || a.implementationDigest.localeCompare(b.implementationDigest)),
    subjectGrants: [...request.subjectGrants].sort((a, b) => a.id.localeCompare(b.id)),
    actorGrants: [...request.actorGrants].sort((a, b) => a.id.localeCompare(b.id)),
    eligibilities: [...request.eligibilities].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function evaluateAuthorization(input: unknown, clock: Clock): AuthorizationDecision {
  const request = AuthorizationRequest.parse(input);
  const evaluatedAt = nowFrom(clock);
  const requestDigest = digest(canonicalRequestSnapshot(request));
  const subjectPrincipalId = request.subject?.principal.id ?? null;
  const actorPrincipalId = request.identity.actor ? request.actor?.principal.id ?? null : subjectPrincipalId;

  const finish = (decision: "allow" | "deny", reasonCode: AuthorizationReason, supports: Support[] = []) => {
    const grantIds = supports.map(({ grantId }) => grantId).sort();
    const permissionSetDigests = [...new Set(supports.map(({ permissionDigest }) => permissionDigest))].sort();
    const identity = {
      policyImplementationDigest: AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST,
      requestDigest,
      evaluatedAt,
      decision,
      reasonCode,
      grantIds,
      permissionSetDigests,
    };
    return AuthorizationDecision.parse({
      contractVersion: AUTHORIZATION_DECISION_CONTRACT_VERSION,
      decisionId: digest(identity),
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      evaluatedAt,
      subjectPrincipalId,
      actorPrincipalId,
      actionUri: request.action.uri,
      resourceKind: request.resource.kind,
      resourceId: request.resource.id,
      decision,
      reasonCode,
      grantIds: decision === "allow" ? grantIds : [],
      permissionSetDigests: decision === "allow" ? permissionSetDigests : [],
      policyImplementationDigest: AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST,
      requestDigest,
    });
  };

  const action = getRegisteredAction(request.action.uri);
  if (!action) return finish("deny", "unknown_action");
  if (!exactAction(request.action, action)) return finish("deny", "action_identity_mismatch");
  if (!action.resourceKinds.includes(request.resource.kind)) return finish("deny", "action_resource_mismatch");
  if (!request.identity.audience.includes(request.serviceAudience)) return finish("deny", "service_audience_mismatch");
  if (request.identity.notBefore !== null && evaluatedAt < request.identity.notBefore) return finish("deny", "identity_not_yet_valid");
  if (evaluatedAt < request.identity.authenticatedAt) return finish("deny", "identity_not_yet_valid");
  if (evaluatedAt >= request.identity.expiresAt) return finish("deny", "identity_expired");
  if (!request.subject) return finish("deny", "membership_required");
  if (!bindingMatches(request.subject, request.workspaceId, request.identity.issuer, request.identity.subject)) {
    return finish("deny", "subject_binding_mismatch");
  }
  if (evaluatedAt < request.subject.binding.createdAt) return finish("deny", "subject_binding_not_yet_valid");
  if (request.subject.binding.status !== "enabled") return finish("deny", "subject_binding_disabled");
  if (request.subject.principal.status !== "enabled") return finish("deny", "subject_principal_disabled");

  if (request.identity.actor) {
    if (!request.actor) return finish("deny", "actor_binding_required");
    if (!bindingMatches(request.actor, request.workspaceId, request.identity.actor.issuer, request.identity.actor.subject)) {
      return finish("deny", "actor_binding_mismatch");
    }
    if (evaluatedAt < request.actor.binding.createdAt) return finish("deny", "actor_binding_not_yet_valid");
    if (request.actor.binding.status !== "enabled") return finish("deny", "actor_binding_disabled");
    if (request.actor.principal.status !== "enabled") return finish("deny", "actor_principal_disabled");
  } else if (request.actor !== null) {
    return finish("deny", "actor_binding_mismatch");
  }

  if (action.senderConstraint === "required" && request.identity.credentialBinding.kind === "none") {
    return finish("deny", "sender_constraint_required");
  }
  if (!request.identity.actionUpperBound.some((identity) => exactAction(identity, action))) {
    return finish("deny", "token_upper_bound_denied");
  }

  const snapshot = authoritySnapshot(request);
  if (!snapshot.valid) return finish("deny", "authority_snapshot_invalid");
  const subjectSupport = supportingGrant(
    request.subjectGrants, request.subject.principal.id, request, action, snapshot.definitions, evaluatedAt,
  );
  if (!subjectSupport) return finish("deny", "subject_grant_denied");
  const supports = [subjectSupport];

  if (request.identity.actor) {
    const actor = request.actor!;
    const actorSupport = supportingGrant(
      request.actorGrants, actor.principal.id, request, action, snapshot.definitions, evaluatedAt,
    );
    if (!actorSupport) return finish("deny", "actor_grant_denied");
    const delegation = request.delegation;
    if (!delegation || delegation.workspaceId !== request.workspaceId ||
        delegation.subjectPrincipalId !== request.subject.principal.id ||
        delegation.actorPrincipalId !== actor.principal.id || !live(delegation, evaluatedAt) ||
        !covers(delegation.scope, request.resource) ||
        !delegation.actions.some((identity) => exactAction(identity, action))) {
      return finish("deny", "delegation_denied");
    }
    supports.push(actorSupport);
  } else if (request.delegation !== null || request.actorGrants.length > 0) {
    return finish("deny", "authority_snapshot_invalid");
  }

  if (action.eligibility !== "none") {
    const effectiveActor = request.identity.actor ? request.actor!.principal : request.subject.principal;
    if (action.eligibility === "effect_connector" && effectiveActor.kind !== "service") {
      return finish("deny", "effect_eligibility_required");
    }
    const eligible = request.eligibilities.some((entry) =>
      entry.workspaceId === request.workspaceId && entry.principalId === effectiveActor.id &&
      entry.kind === action.eligibility && live(entry, evaluatedAt));
    if (!eligible) return finish("deny", "effect_eligibility_required");
  }

  return finish("allow", "allowed", supports);
}

export function definePermissionSet(input: {
  uri: string;
  version: number;
  actions: ActionDefinition[];
}): PermissionSetDefinition {
  const actions = input.actions.map(({ uri, version, implementationDigest }) => ({ uri, version, implementationDigest }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  const semantic = { uri: input.uri, version: input.version, actions };
  return PermissionSetDefinition.parse({ ...semantic, implementationDigest: digest(semantic) });
}
