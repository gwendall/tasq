import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Clock } from "@tasq-run/schema";
import {
  definePermissionSet,
  getRegisteredAction,
  type ActionDefinition,
} from "@tasq-internal/authority";
import { z } from "zod";
import {
  openAuthorityStore,
  type AuthorityMutationContext,
  type AuthorityStore,
} from "./store.js";
import {
  registeredActionIdentities,
  type TasqServerConfig,
} from "./config.js";

export const TASQ_SERVER_BOOTSTRAP_VERSION = "tasq.server-bootstrap.v1" as const;
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const Id = z.string().min(1).max(500).refine((value) => value === value.trim());
const Issuer = z.string().url().refine((value) => new URL(value).protocol === "https:");
const Method = z.union([z.enum(["oidc", "oauth_introspection", "spiffe"]), z.string().url()]);

export const TasqServerBootstrap = z.object({
  contractVersion: z.literal(TASQ_SERVER_BOOTSTRAP_VERSION),
  hostTenantId: Id,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  workspaces: z.array(z.object({
    id: WorkspaceId,
    principals: z.array(z.object({
      id: Id,
      kind: z.enum(["human", "agent", "service", "runtime"]),
      issuer: Issuer,
      subject: Id,
      method: Method,
      role: z.enum(["reader", "coordinator"]),
    }).strict()).min(1).max(100),
  }).strict()).min(1).max(1_000),
}).strict();
export type TasqServerBootstrap = z.infer<typeof TasqServerBootstrap>;

export async function loadTasqServerBootstrap(path: string): Promise<TasqServerBootstrap> {
  if (!isAbsolute(path)) throw new Error("Tasq Server bootstrap path must be absolute");
  return TasqServerBootstrap.parse(JSON.parse(await readFile(path, "utf8")));
}

function operation(workspaceId: string | null, suffix: string, expected: number | null): AuthorityMutationContext {
  return {
    operationId: `bootstrap:${workspaceId ?? "host"}:${suffix}`,
    actorPrincipalId: expected === null ? "self-host-operator" : null,
    reason: "declarative initial Server bootstrap",
    expectedAuthorityRevision: expected,
  };
}

function definitions(role: "reader" | "coordinator"): ActionDefinition[] {
  const allowed = role === "reader"
    ? new Set(["urn:tasq:action:workspace.read", "urn:tasq:action:commitment.read"])
    : new Set(registeredActionIdentities().map(({ uri }) => uri));
  return [...allowed].map((uri) => {
    const found = getRegisteredAction(uri);
    if (!found) throw new Error(`missing registered action ${uri}`);
    return found;
  }).sort((left, right) => left.uri.localeCompare(right.uri));
}

export async function bootstrapTasqServer(input: {
  config: TasqServerConfig;
  bootstrap: TasqServerBootstrap;
  clock: Clock;
  store?: AuthorityStore;
}): Promise<{ workspaces: number; principals: number; finalAuthorityRevisions: Record<string, number> }> {
  const bootstrap = TasqServerBootstrap.parse(input.bootstrap);
  if (bootstrap.hostTenantId !== input.config.hostTenantId) {
    throw new Error("bootstrap host tenant does not match Server config");
  }
  const configured = new Map(input.config.workspaces.map((workspace) => [workspace.id, workspace]));
  if (bootstrap.workspaces.length !== configured.size
    || bootstrap.workspaces.some(({ id }) => !configured.has(id))) {
    throw new Error("bootstrap workspaces must exactly match Server config");
  }
  const ownStore = input.store === undefined;
  const store = input.store ?? await openAuthorityStore({
    url: input.config.authorityDatabaseUrl,
    clock: input.clock,
  });
  let principalCount = 0;
  const finalAuthorityRevisions: Record<string, number> = {};
  try {
    await store.provisionHostTenant({
      id: bootstrap.hostTenantId,
      context: operation(null, "tenant", null),
    });
    for (const workspace of [...bootstrap.workspaces].sort((a, b) => a.id.localeCompare(b.id))) {
      const configuredWorkspace = configured.get(workspace.id)!;
      await store.provisionWorkspace({
        workspaceId: workspace.id,
        hostTenantId: bootstrap.hostTenantId,
        storageBindingId: configuredWorkspace.storageBindingId,
        context: operation(workspace.id, "workspace", null),
      });
      let authorityRevision = 0;
      const principals = [...workspace.principals].sort((a, b) => a.id.localeCompare(b.id));
      if (new Set(principals.map(({ id }) => id)).size !== principals.length
        || new Set(principals.map(({ issuer, subject }) => `${issuer}\u0000${subject}`)).size !== principals.length) {
        throw new Error(`bootstrap workspace ${workspace.id} contains duplicate principal or subject identities`);
      }
      for (const principal of principals) {
        const result = await store.registerPrincipal({
          principal: {
            id: principal.id,
            workspaceId: workspace.id,
            kind: principal.kind,
            status: "enabled",
            revision: 1,
          },
          context: operation(workspace.id, `principal:${principal.id}`, authorityRevision),
        });
        authorityRevision = result.authorityRevision!;
        principalCount += 1;
      }
      for (const principal of principals) {
        const binding = await store.bindSubject({
          binding: {
            contractVersion: "tasq.subject-binding.v1",
            id: `bootstrap-binding:${principal.id}`,
            workspaceId: workspace.id,
            principalId: principal.id,
            issuer: principal.issuer,
            subject: principal.subject,
            method: principal.method,
            status: "enabled",
            revision: 1,
            createdAt: bootstrap.createdAt,
            disabledAt: null,
            replacedByBindingId: null,
          },
          context: operation(workspace.id, `binding:${principal.id}`, authorityRevision),
        });
        authorityRevision = binding.authorityRevision!;
        const permission = definePermissionSet({
          uri: `urn:tasq:server:permission:${principal.role}:${encodeURIComponent(principal.id)}`,
          version: 1,
          actions: definitions(principal.role),
        });
        const activated = await store.activatePermissionSet({
          workspaceId: workspace.id,
          permissionSet: permission,
          context: operation(workspace.id, `permission:${principal.id}`, authorityRevision),
        });
        authorityRevision = activated.authorityRevision!;
        const granted = await store.createGrant({
          grant: {
            contractVersion: "tasq.authorization-grant.v1",
            id: `bootstrap-grant:${principal.id}`,
            workspaceId: workspace.id,
            grantorPrincipalId: principals[0]!.id,
            granteePrincipalId: principal.id,
            permissionSet: {
              uri: permission.uri,
              version: permission.version,
              implementationDigest: permission.implementationDigest,
            },
            scope: { kind: "workspace" },
            notBefore: bootstrap.createdAt,
            expiresAt: null,
            status: "active",
            revision: 1,
          },
          context: operation(workspace.id, `grant:${principal.id}`, authorityRevision),
        });
        authorityRevision = granted.authorityRevision!;
      }
      finalAuthorityRevisions[workspace.id] = authorityRevision;
    }
    return {
      workspaces: bootstrap.workspaces.length,
      principals: principalCount,
      finalAuthorityRevisions,
    };
  } finally {
    if (ownStore) await store.close();
  }
}
