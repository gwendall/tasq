/** Universal persisted extension identities. Contains no provider definitions. */

import { z } from "zod";

export const EXTENSION_RECORD_KINDS = [
  "condition",
  "observation",
  "evidence",
  "artifact",
  "effect",
] as const;
export const ExtensionRecordKind = z.enum(EXTENSION_RECORD_KINDS);
export type ExtensionRecordKind = z.infer<typeof ExtensionRecordKind>;

export const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type Sha256Digest = z.infer<typeof Sha256Digest>;
export const HttpsUri = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname.length > 0;
}, "must be an absolute HTTPS URI");
export type HttpsUri = z.infer<typeof HttpsUri>;

const UuidV7String = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
const UnixMs = z.number().int().nonnegative();

export const ExtensionRelease = z.object({
  id: UuidV7String,
  tenantId: z.string().min(1),
  extensionUri: HttpsUri,
  version: z.string().min(1),
  manifest: z.record(z.unknown()),
  manifestDigest: Sha256Digest,
  installedAt: UnixMs,
  installedBy: z.string().min(1),
});
export type ExtensionRelease = z.infer<typeof ExtensionRelease>;

export const ExtensionTypeRegistration = z.object({
  id: UuidV7String,
  tenantId: z.string().min(1),
  extensionReleaseId: UuidV7String,
  recordKind: ExtensionRecordKind,
  typeUri: HttpsUri,
  schemaVersion: z.number().int().positive(),
  schema: z.record(z.unknown()),
  schemaDigest: Sha256Digest,
  createdAt: UnixMs,
});
export type ExtensionTypeRegistration = z.infer<typeof ExtensionTypeRegistration>;

export const ExtensionEvaluatorRegistration = z.object({
  id: UuidV7String,
  tenantId: z.string().min(1),
  extensionReleaseId: UuidV7String,
  evaluatorUri: HttpsUri,
  evaluatorVersion: z.number().int().positive(),
  conditionTypeUri: HttpsUri,
  conditionSchemaVersion: z.number().int().positive(),
  acceptedObservationTypes: z.array(z.object({
    typeUri: HttpsUri,
    schemaVersion: z.number().int().positive(),
  })).min(1),
  implementationDigest: Sha256Digest,
  createdAt: UnixMs,
});
export type ExtensionEvaluatorRegistration = z.infer<typeof ExtensionEvaluatorRegistration>;

export interface ExtensionManifestType {
  recordKind: ExtensionRecordKind;
  typeUri: string;
  schemaVersion: number;
  schema: Record<string, unknown>;
}

export interface AcceptedObservationType {
  typeUri: string;
  schemaVersion: number;
}

export interface ExtensionManifestEvaluator {
  evaluatorUri: string;
  evaluatorVersion: number;
  conditionTypeUri: string;
  conditionSchemaVersion: number;
  acceptedObservationTypes: AcceptedObservationType[];
  implementationDigest: string;
}

export interface ExtensionManifest {
  extensionUri: string;
  version: string;
  types: ExtensionManifestType[];
  evaluators: ExtensionManifestEvaluator[];
}
