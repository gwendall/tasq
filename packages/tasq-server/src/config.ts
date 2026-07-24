import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  ActionIdentity,
  getRegisteredAction,
  type ActionIdentity as ActionIdentityValue,
} from "@tasq-internal/authority";
import { z } from "zod";

export const TASQ_SERVER_CONFIG_VERSION = "tasq.server-config.v1" as const;

const CanonicalHttps = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "must be one canonical HTTPS URL" });
  }
});
const FileDatabaseUrl = z.string().superRefine((value, context) => {
  if (!value.startsWith("file:")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "must be an absolute file: SQLite URL" });
    return;
  }
  const path = value.slice("file:".length);
  if (!isAbsolute(path) || path.includes("?") || path.includes("#")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "must be an absolute file: SQLite URL without options" });
  }
});
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const Id = z.string().min(1).max(500).refine((value) => value === value.trim());
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const JsonWebKeySchema = z.object({
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
  alg: z.literal("RS256").optional(),
  use: z.literal("sig").optional(),
  kid: z.string().optional(),
}).passthrough();

const Jwt = z.object({
  issuer: CanonicalHttps,
  audience: CanonicalHttps,
  keys: z.array(z.object({ kid: Id, jwk: JsonWebKeySchema }).strict()).min(1).max(32),
  scopeActions: z.record(z.union([
    z.array(ActionIdentity).min(1).max(32),
    z.enum(["reader", "coordinator"]),
  ])),
  clockSkewMs: z.number().int().min(0).max(300_000).default(30_000),
}).strict();

const Workspace = z.object({
  id: WorkspaceId,
  storageBindingId: Id,
  databaseUrl: FileDatabaseUrl,
  receiptDatabaseUrl: FileDatabaseUrl,
}).strict();

export const TasqServerConfig = z.object({
  contractVersion: z.literal(TASQ_SERVER_CONFIG_VERSION),
  publicUrl: CanonicalHttps,
  listen: z.object({
    host: z.string().min(1).max(255).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(8787),
    trustTlsProxy: z.boolean().default(false),
  }).strict(),
  authorityDatabaseUrl: FileDatabaseUrl,
  hostTenantId: Id,
  enrollment: z.object({
    issuer: CanonicalHttps,
    accessLifetimeMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1_000),
  }).strict(),
  jwt: Jwt,
  additionalJwtIssuers: z.array(Jwt).max(7).default([]),
  signing: z.object({
    /** Exact signing authority roots accepted for statement verification. */
    acceptedTrustRootDigests: z.array(Digest).max(64).default([]),
  }).strict().default({ acceptedTrustRootDigests: [] }),
  workspaces: z.array(Workspace).min(1).max(1_000),
  support: z.object({
    documentationUrl: CanonicalHttps.optional(),
    contact: z.string().email().optional(),
  }).strict().default({}),
}).strict().superRefine((value, context) => {
  const publicUrl = new URL(value.publicUrl);
  if (publicUrl.pathname !== "/") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["publicUrl"], message: "v1 daemon requires an origin URL ending in /" });
  }
  if (value.jwt.audience !== value.publicUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["jwt", "audience"], message: "must equal publicUrl" });
  }
  for (const [index, issuer] of value.additionalJwtIssuers.entries()) {
    if (issuer.audience !== value.publicUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["additionalJwtIssuers", index, "audience"],
        message: "must equal publicUrl",
      });
    }
  }
  const jwtIssuers = [value.jwt.issuer, ...value.additionalJwtIssuers.map(({ issuer }) => issuer)];
  if (new Set(jwtIssuers).size !== jwtIssuers.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["additionalJwtIssuers"], message: "JWT issuers must be unique" });
  }
  if (value.enrollment.issuer !== value.publicUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enrollment", "issuer"], message: "must equal publicUrl" });
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(value.listen.host) && !value.listen.trustTlsProxy) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["listen", "trustTlsProxy"],
      message: "must be true before binding a non-loopback interface behind a TLS proxy",
    });
  }
  const workspaceIds = value.workspaces.map(({ id }) => id);
  const bindings = value.workspaces.map(({ storageBindingId }) => storageBindingId);
  const databaseUrls = value.workspaces.flatMap(({ databaseUrl, receiptDatabaseUrl }) => [databaseUrl, receiptDatabaseUrl]);
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces"], message: "workspace IDs must be unique" });
  }
  if (new Set(bindings).size !== bindings.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces"], message: "storage bindings must be unique" });
  }
  if (new Set(databaseUrls).size !== databaseUrls.length || databaseUrls.includes(value.authorityDatabaseUrl)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces"], message: "every authority/domain/receipt database URL must be distinct" });
  }
  for (const [scope, actions] of Object.entries(value.jwt.scopeActions)) {
    if (typeof actions === "string") continue;
    for (const action of actions) {
      const registered = getRegisteredAction(action.uri);
      if (!registered || registered.version !== action.version
        || registered.implementationDigest !== action.implementationDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["jwt", "scopeActions", scope],
          message: `contains unknown action identity ${action.uri}`,
        });
      }
    }
  }
  for (const [issuerIndex, issuer] of value.additionalJwtIssuers.entries()) {
    for (const [scope, actions] of Object.entries(issuer.scopeActions)) {
      if (typeof actions === "string") continue;
      for (const action of actions) {
        const registered = getRegisteredAction(action.uri);
        if (!registered || registered.version !== action.version
          || registered.implementationDigest !== action.implementationDigest) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["additionalJwtIssuers", issuerIndex, "scopeActions", scope],
            message: `contains unknown action identity ${action.uri}`,
          });
        }
      }
    }
  }
});
export type TasqServerConfig = z.infer<typeof TasqServerConfig>;

export async function loadTasqServerConfig(path: string): Promise<TasqServerConfig> {
  if (!isAbsolute(path)) throw new Error("Tasq Server config path must be absolute");
  const raw = await readFile(path, "utf8");
  return TasqServerConfig.parse(JSON.parse(raw));
}

export function registeredActionIdentities(): ActionIdentityValue[] {
  const uris = [
    "urn:tasq:action:workspace.read",
    "urn:tasq:action:commitment.read",
    "urn:tasq:action:commitment.propose",
    "urn:tasq:action:commitment.mutate",
    "urn:tasq:action:claim.coordinate",
    "urn:tasq:action:attempt.execute",
    "urn:tasq:action:evidence.append",
    "urn:tasq:action:resolution.trust",
    "urn:tasq:action:resolution.propose",
    "urn:tasq:action:resolution.decide",
    "urn:tasq:action:statement.accept",
    "urn:tasq:action:resource.coordinate",
    "urn:tasq:action:replication.enroll",
    "urn:tasq:action:replication.push",
    "urn:tasq:action:replication.pull",
  ];
  return uris.map((uri) => {
    const found = getRegisteredAction(uri);
    if (!found) throw new Error(`missing registered Server action ${uri}`);
    return {
      uri: found.uri,
      version: found.version,
      implementationDigest: found.implementationDigest,
    };
  }).sort((left, right) => left.uri.localeCompare(right.uri));
}

export function configuredScopeActions(
  configured: TasqServerConfig["jwt"]["scopeActions"],
): Record<string, ActionIdentityValue[]> {
  const all = registeredActionIdentities();
  const readers = new Set(["urn:tasq:action:workspace.read", "urn:tasq:action:commitment.read"]);
  return Object.fromEntries(Object.entries(configured).map(([scope, value]) => [
    scope,
    typeof value === "string"
      ? all.filter(({ uri }) => value === "coordinator" || readers.has(uri))
      : value,
  ]));
}
