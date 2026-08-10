import { createHash } from "node:crypto";
import { z } from "zod";
import { TargetRefV1, canonicalizeEffectJson } from "@tasq-run/schema";

export const CUSTODY_MODULE_VERSION = "tasq.experimental-custody.v1" as const;
export const CUSTODY_PORTABLE_VERSION = "tasq.experimental-custody-portable.v1" as const;
export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Id = z.string().min(1).max(500);
const UnixMs = z.number().int().nonnegative();
const JsonObject = z.record(z.unknown());

export function custodyDigest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${domain}\0${canonicalizeEffectJson(value)}`).digest("hex")}`;
}

export const CustodyTargetV1 = z.object({
  contractVersion: z.literal(CUSTODY_MODULE_VERSION),
  workspaceId: Id,
  targetDigest: Digest,
  target: TargetRefV1,
  createdAt: UnixMs,
}).strict();
export type CustodyTargetV1 = z.infer<typeof CustodyTargetV1>;

export const CustodyStateV1 = z.object({
  contractVersion: z.literal(CUSTODY_MODULE_VERSION),
  id: Id,
  workspaceId: Id,
  targetDigest: Digest,
  custodianPrincipalId: Id,
  predecessorStateId: Id.nullable(),
  acceptedHandoffId: Id.nullable(),
  condition: JsonObject,
  conditionDigest: Digest,
  evidenceRefs: z.array(Id).min(1).max(100),
  effectiveAt: UnixMs,
  recordedAt: UnixMs,
}).strict();
export type CustodyStateV1 = z.infer<typeof CustodyStateV1>;

export const CustodyHandoffV1 = z.object({
  contractVersion: z.literal(CUSTODY_MODULE_VERSION),
  id: Id,
  workspaceId: Id,
  targetDigest: Digest,
  sourceStateId: Id,
  fromPrincipalId: Id,
  toPrincipalId: Id,
  status: z.enum(["offered", "accepted", "refused"]),
  condition: JsonObject,
  conditionDigest: Digest,
  evidenceRequirements: z.array(z.string().min(1).max(500)).max(100),
  acceptanceEvidence: z.array(z.object({
    requirement: z.string().min(1).max(500),
    evidenceRef: Id,
  }).strict()).max(100),
  offeredAt: UnixMs,
  expiresAt: UnixMs,
  decidedAt: UnixMs.nullable(),
  refusalReason: z.string().min(1).max(2_000).nullable(),
  revision: z.number().int().positive(),
}).strict();
export type CustodyHandoffV1 = z.infer<typeof CustodyHandoffV1>;

export const CustodyIncidentV1 = z.object({
  contractVersion: z.literal(CUSTODY_MODULE_VERSION),
  id: Id,
  workspaceId: Id,
  targetDigest: Digest,
  stateId: Id,
  reporterPrincipalId: Id,
  kindUri: z.string().url().max(2_000),
  summary: z.string().min(1).max(2_000),
  evidenceRefs: z.array(Id).max(100),
  occurredAt: UnixMs,
  recordedAt: UnixMs,
}).strict();
export type CustodyIncidentV1 = z.infer<typeof CustodyIncidentV1>;

export interface CustodyMutationContext {
  workspaceId: string;
  actorPrincipalId: string;
  idempotencyKey: string;
}

export interface CustodyCurrentViewV1 {
  contractVersion: typeof CUSTODY_MODULE_VERSION;
  assurance: {
    recordedLineageIsPhysicalTruth: false;
    grantsOwnershipOrEffectAuthority: false;
  };
  target: CustodyTargetV1;
  currentState: CustodyStateV1;
  states: CustodyStateV1[];
  handoffs: CustodyHandoffV1[];
  incidents: CustodyIncidentV1[];
  inspectedAt: number;
}

export interface CustodyPortableV1 {
  contractVersion: typeof CUSTODY_PORTABLE_VERSION;
  workspaceId: string;
  exportedAt: number;
  targets: CustodyTargetV1[];
  states: CustodyStateV1[];
  handoffs: CustodyHandoffV1[];
  incidents: CustodyIncidentV1[];
  omissions: ["idempotency", "operational_events"];
  exportDigest: `sha256:${string}`;
}
