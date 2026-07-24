import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudControlPlane,
  cloudSessionCookie,
  createCloudBff,
  type CloudAction,
  type CloudAuthorizationRequest,
  type CloudProvisioner,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function authority(now: () => number) {
  const decisions: CloudAuthorizationRequest[] = [];
  return {
    decisions,
    authorize: async (input: CloudAuthorizationRequest) => {
      decisions.push(input);
      return {
        decisionId: `decision-${decisions.length}`,
        actorPrincipalId: "cloud:operator",
        decision: "allow" as const,
        evaluatedAt: now(),
      };
    },
  };
}

describe("TQ-901–TQ-905 managed Cloud source candidate", () => {
  test("isolates provisioning, sessions, BFF, lifecycle, support and deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-cloud-"));
    roots.push(root);
    const databasePath = join(root, "control.sqlite");
    let current = 1_900_000_000_000;
    const authorization = authority(() => current);
    const provisionCalls: Array<Record<string, string>> = [];
    let failWorkspace = "";
    let failDeleteOnce = false;
    const provisioner: CloudProvisioner = {
      async provision(input) {
        provisionCalls.push(input);
        if (input.workspaceId === failWorkspace) throw new Error("provider_capacity");
        return {
          deploymentRef: `deployment:${input.tenantId}:${input.workspaceId}`,
          serverOrigin: `https://${input.tenantId}-${input.workspaceId.replaceAll("/", "-")}.server.example/`,
          secretRefs: [`secret:${input.tenantId}:${input.workspaceId}`],
        };
      },
      async export(input) {
        return {
          artifactRef: `export:${input.exportId}`,
          artifactDigest: `sha256:${"a".repeat(64)}`,
          expiresAt: current + 60_000,
        };
      },
      async rotateCredentials(input) {
        return { secretRefs: [`secret:${input.rotationId}:replacement`] };
      },
      async backup(input) {
        return {
          artifactRef: `backup:${input.backupId}`,
          artifactDigest: `sha256:${"b".repeat(64)}`,
        };
      },
      async restore(input) {
        return {
          deploymentRef: `restored:${input.backupId}`,
          serverOrigin: `https://${input.tenantId}-${input.workspaceId}.restored.example/`,
          secretRefs: [`secret:restored:${input.backupId}`],
        };
      },
      async delete() {
        if (failDeleteOnce) {
          failDeleteOnce = false;
          throw new Error("provider_delete_timeout");
        }
      },
    };
    const control = await CloudControlPlane.open({
      url: `file:${databasePath}`,
      clock: { now: () => current },
      identityPepper: new Uint8Array(32).fill(1),
      sessionPepper: new Uint8Array(32).fill(2),
      authorize: authorization.authorize,
      provisioner,
    });
    try {
      for (const id of ["alpha", "beta"]) {
        await control.createTenant({
          id,
          slug: id,
          plan: "managed-alpha",
          maxWorkspaces: id === "alpha" ? 2 : 1,
          retentionDays: 30,
          operationId: `create-${id}`,
        });
      }
      const alpha = await control.provisionWorkspace({
        tenantId: "alpha",
        workspaceId: "shared",
        region: "eu-west",
        operationId: "alpha-shared",
      });
      const beta = await control.provisionWorkspace({
        tenantId: "beta",
        workspaceId: "shared",
        region: "us-east",
        operationId: "beta-shared",
      });
      expect(alpha).toMatchObject({
        tenantId: "alpha",
        status: "ready",
        secretRefs: ["secret:alpha:shared"],
      });
      expect(beta).toMatchObject({
        tenantId: "beta",
        status: "ready",
        secretRefs: ["secret:beta:shared"],
      });
      expect(alpha.storageBindingId).not.toBe(beta.storageBindingId);
      expect((await control.provisionWorkspace({
        tenantId: "alpha",
        workspaceId: "shared",
        region: "eu-west",
        operationId: "alpha-shared",
      })).storageBindingId).toBe(alpha.storageBindingId);
      await expect(control.provisionWorkspace({
        tenantId: "beta",
        workspaceId: "over-quota",
        region: "us-east",
        operationId: "beta-over-quota",
      })).rejects.toThrow("workspace_quota_exceeded");

      failWorkspace = "recoverable";
      expect(await control.provisionWorkspace({
        tenantId: "alpha",
        workspaceId: "recoverable",
        region: "eu-west",
        operationId: "alpha-recoverable",
      })).toMatchObject({ status: "failed", lastErrorCode: "provider_capacity" });
      failWorkspace = "";
      expect(await control.reconcileWorkspace({
        tenantId: "alpha",
        workspaceId: "recoverable",
      })).toMatchObject({ status: "ready" });

      for (const tenantId of ["alpha", "beta"]) {
        await control.registerPrincipal({
          tenantId,
          principalId: `human:${tenantId}`,
          kind: "human",
          issuer: "https://identity.example/",
          subject: `subject-${tenantId}`,
          operationId: `principal-${tenantId}`,
        });
        await control.enrollDevice({
          tenantId,
          principalId: `human:${tenantId}`,
          deviceId: `device:${tenantId}`,
          label: `${tenantId} browser`,
        });
      }
      const alphaSession = await control.issueHumanSession({
        tenantId: "alpha",
        issuer: "https://identity.example/",
        subject: "subject-alpha",
        deviceId: "device:alpha",
      });
      const betaSession = await control.issueHumanSession({
        tenantId: "beta",
        issuer: "https://identity.example/",
        subject: "subject-beta",
        deviceId: "device:beta",
      });
      expect(cloudSessionCookie(
        alphaSession.token,
        alphaSession.expiresAt,
        current,
      )).toContain("Secure; HttpOnly; SameSite=Strict");

      const downstream: Array<{
        url: string;
        authorization: string | null;
        cookie: string | null;
      }> = [];
      const bff = createCloudBff({
        publicOrigin: "https://cloud.tasq.run/",
        controlPlane: control,
        resolveServerCredential: async ({ tenantId, principalId }) =>
          `server-token:${tenantId}:${principalId}`,
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          downstream.push({
            url: String(input),
            authorization: headers.get("authorization"),
            cookie: headers.get("cookie"),
          });
          return new Response(JSON.stringify({ ok: true }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "must-not-escape=1",
            },
          });
        },
      });
      const alphaRead = await bff(new Request(
        "https://cloud.tasq.run/api/tenants/alpha/workspaces/shared/v1/workspaces/shared/commitments",
        { headers: { cookie: `__Host-tasq_session=${alphaSession.token}` } },
      ));
      expect(alphaRead.status).toBe(200);
      expect(alphaRead.headers.get("set-cookie")).toBeNull();
      expect(downstream[0]).toMatchObject({
        url: "https://alpha-shared.server.example/v1/workspaces/shared/commitments",
        authorization: "Bearer server-token:alpha:human:alpha",
        cookie: null,
      });
      expect((await bff(new Request(
        "https://cloud.tasq.run/api/tenants/beta/workspaces/shared/v1/workspaces/shared/commitments",
        { headers: { cookie: `__Host-tasq_session=${alphaSession.token}` } },
      ))).status).toBe(401);
      expect((await bff(new Request(
        "https://cloud.tasq.run/api/tenants/alpha/workspaces/shared/v1/workspaces/shared/operations/commitment.propose",
        {
          method: "POST",
          headers: {
            cookie: `__Host-tasq_session=${alphaSession.token}`,
            origin: "https://cloud.tasq.run",
          },
          body: "{}",
        },
      ))).status).toBe(401);
      expect((await bff(new Request(
        "https://cloud.tasq.run/api/tenants/alpha/workspaces/shared/v1/workspaces/shared/operations/commitment.propose",
        {
          method: "POST",
          headers: {
            cookie: `__Host-tasq_session=${alphaSession.token}`,
            origin: "https://evil.example",
            "x-tasq-csrf": alphaSession.csrfToken,
          },
          body: "{}",
        },
      ))).status).toBe(403);
      expect((await bff(new Request(
        "https://cloud.tasq.run/api/tenants/alpha/workspaces/shared/v1/workspaces/shared/effects/dispatch",
        {
          method: "POST",
          headers: {
            cookie: `__Host-tasq_session=${alphaSession.token}`,
            origin: "https://cloud.tasq.run",
            "x-tasq-csrf": alphaSession.csrfToken,
          },
          body: "{}",
        },
      ))).status).toBe(403);

      await control.revokeDevice({
        tenantId: "alpha",
        deviceId: "device:alpha",
        expectedRevision: 1,
      });
      expect(await control.authenticateSession(alphaSession.token)).toBeNull();
      expect(await control.authenticateSession(betaSession.token)).toMatchObject({
        tenantId: "beta",
      });
      await control.recoverHuman({
        tenantId: "beta",
        principalId: "human:beta",
        verifiedRecoveryProofId: "recovery-proof-1",
      });
      expect(await control.authenticateSession(betaSession.token)).toBeNull();

      await control.registerPrincipal({
        tenantId: "alpha",
        principalId: "workload:alpha",
        kind: "workload",
        issuer: "https://workload.example/",
        subject: "spiffe-alpha",
        operationId: "workload-principal-alpha",
      });
      await control.enrollWorkload({
        tenantId: "alpha",
        principalId: "workload:alpha",
        workloadId: "workload-instance-alpha",
        credentialRef: "secret-manager:workload-alpha",
      });
      expect(await control.revokeWorkload({
        tenantId: "alpha",
        workloadId: "workload-instance-alpha",
        expectedRevision: 1,
      })).toMatchObject({ status: "revoked", revision: 2 });

      expect(await control.requestExport({
        tenantId: "alpha",
        workspaceId: "shared",
      })).toMatchObject({
        status: "ready",
        artifactDigest: `sha256:${"a".repeat(64)}`,
      });
      expect(await control.rotateWorkspaceCredentials({
        tenantId: "alpha",
        workspaceId: "shared",
        rotationId: "rotation-alpha-1",
      })).toEqual({
        rotationId: "rotation-alpha-1",
        status: "ready",
        secretRefs: ["secret:rotation-alpha-1:replacement"],
      });
      expect((await control.getWorkspace("alpha", "shared"))?.secretRefs)
        .toEqual(["secret:rotation-alpha-1:replacement"]);
      expect(await control.rotateWorkspaceCredentials({
        tenantId: "alpha",
        workspaceId: "shared",
        rotationId: "rotation-alpha-1",
      })).toMatchObject({ status: "ready" });
      const backup = await control.createBackup({
        tenantId: "alpha",
        workspaceId: "shared",
        backupId: "backup-alpha-1",
        lifetimeMs: 60_000,
      });
      expect(backup).toMatchObject({
        status: "ready",
        artifactDigest: `sha256:${"b".repeat(64)}`,
      });
      expect(await control.restoreBackup({
        tenantId: "alpha",
        workspaceId: "shared",
        backupId: "backup-alpha-1",
      })).toMatchObject({
        status: "ready",
        deploymentRef: "restored:backup-alpha-1",
        secretRefs: ["secret:restored:backup-alpha-1"],
      });
      const support = await control.grantSupportAccess({
        tenantId: "alpha",
        supportPrincipalId: "support:oncall",
        scope: "metadata",
        reason: "Investigate incident",
        ticketRef: "ticket-42",
        lifetimeMs: 60_000,
      });
      expect(await control.hasSupportAccess({
        id: support.id,
        tenantId: "alpha",
        supportPrincipalId: "support:oncall",
        scope: "metadata",
      })).toBeTrue();
      expect(await control.revokeSupportAccess({
        id: support.id,
        tenantId: "alpha",
      })).toEqual({ id: support.id, status: "revoked" });
      expect(await control.hasSupportAccess({
        id: support.id,
        tenantId: "alpha",
        supportPrincipalId: "support:oncall",
        scope: "metadata",
      })).toBeFalse();
      const expiringSupport = await control.grantSupportAccess({
        tenantId: "alpha",
        supportPrincipalId: "support:oncall",
        scope: "metadata",
        reason: "Retention test",
        ticketRef: "ticket-43",
        lifetimeMs: 60_000,
      });
      current = expiringSupport.expiresAt;
      expect(await control.hasSupportAccess({
        id: expiringSupport.id,
        tenantId: "alpha",
        supportPrincipalId: "support:oncall",
        scope: "metadata",
      })).toBeFalse();
      expect(await control.sweepRetention({ tenantId: "alpha" })).toEqual({
        expiredExports: 1,
        expiredBackups: 1,
        expiredSupportGrants: 1,
      });
      expect(await control.bindBilling({
        tenantId: "alpha",
        providerCustomerRef: "billing-customer-alpha",
        status: "active",
      })).toMatchObject({ grantsAuthority: false });
      expect(await control.recordIncident({
        tenantId: "alpha",
        severity: "sev2",
        summary: "Synthetic isolation incident",
      })).toMatchObject({ status: "open" });
      await expect(control.deleteWorkspace({
        tenantId: "alpha",
        workspaceId: "shared",
        confirmation: "wrong",
      })).rejects.toThrow("confirmation");
      failDeleteOnce = true;
      await expect(control.deleteWorkspace({
        tenantId: "alpha",
        workspaceId: "shared",
        confirmation: "alpha/shared",
      })).rejects.toThrow("provider_delete_timeout");
      expect(await control.deleteWorkspace({
        tenantId: "alpha",
        workspaceId: "shared",
        confirmation: "alpha/shared",
      })).toEqual({ workspaceId: "shared", status: "deleted" });
      expect(await control.getWorkspace("alpha", "shared")).toMatchObject({
        status: "deleted",
        deploymentRef: null,
        serverOrigin: null,
        secretRefs: [],
      });

      const alphaAudit = await control.listAudit("alpha");
      expect(alphaAudit.length).toBeGreaterThan(10);
      expect(alphaAudit.every(({ tenantId }) => tenantId === "alpha")).toBeTrue();
      expect(authorization.decisions.map(({ action }) => action as CloudAction))
        .toContain("support.grant");
    } finally {
      control.close();
    }

    const bytes = await readFile(databasePath);
    const text = bytes.toString("utf8");
    expect(text).not.toContain("subject-alpha");
    expect(text).not.toContain("tasq_cloud_session");
    expect(text).not.toContain("server-token:alpha");
  });

  test("fails closed across tenants, authority denial, quota races and suspension", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-cloud-hostile-"));
    roots.push(root);
    const databasePath = join(root, "control.sqlite");
    let current = 1_900_000_000_000;
    let denied: CloudAction | null = null;
    let alphaWorkspaceId = "";
    const provisioner: CloudProvisioner = {
      async provision(input) {
        return {
          deploymentRef: `deployment:${input.tenantId}:${input.workspaceId}`,
          serverOrigin: `https://${input.tenantId}-${input.workspaceId}.example/`,
          secretRefs: [`secret:${input.tenantId}:${input.workspaceId}:v1`],
        };
      },
      async export(input) {
        return {
          artifactRef: `export:${input.exportId}`,
          artifactDigest: `sha256:${"a".repeat(64)}`,
          expiresAt: current + 60_000,
        };
      },
      async rotateCredentials(input) {
        return { secretRefs: [`secret:${input.tenantId}:${input.rotationId}:v2`] };
      },
      async backup(input) {
        return {
          artifactRef: `backup:${input.backupId}`,
          artifactDigest: `sha256:${"b".repeat(64)}`,
        };
      },
      async restore(input) {
        return {
          deploymentRef: `restored:${input.backupId}`,
          serverOrigin: `https://${input.tenantId}-${input.workspaceId}.restored.example/`,
          secretRefs: [`secret:${input.tenantId}:${input.backupId}:restored`],
        };
      },
      async delete() {},
    };
    const control = await CloudControlPlane.open({
      url: `file:${databasePath}`,
      clock: { now: () => current },
      identityPepper: new Uint8Array(32).fill(3),
      sessionPepper: new Uint8Array(32).fill(4),
      authorize: async (input) => ({
        decisionId: randomDecision(input),
        actorPrincipalId: "cloud:operator",
        decision: input.action === denied ? "deny" : "allow",
        evaluatedAt: current,
      }),
      provisioner,
    });
    try {
      for (const tenantId of ["alpha", "beta"]) {
        await control.createTenant({
          id: tenantId,
          slug: tenantId,
          plan: "alpha",
          maxWorkspaces: 1,
          retentionDays: 30,
          operationId: `tenant:${tenantId}`,
        });
      }
      const quotaRace = await Promise.allSettled([
        control.provisionWorkspace({
          tenantId: "alpha",
          workspaceId: "first",
          region: "eu-west",
          operationId: "alpha:first",
        }),
        control.provisionWorkspace({
          tenantId: "alpha",
          workspaceId: "second",
          region: "eu-west",
          operationId: "alpha:second",
        }),
      ]);
      expect(quotaRace.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(quotaRace.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const alphaWorkspace = quotaRace.find(({ status }) => status === "fulfilled");
      if (!alphaWorkspace || alphaWorkspace.status !== "fulfilled") {
        throw new Error("expected one provisioned alpha workspace");
      }
      alphaWorkspaceId = alphaWorkspace.value.id;
      await control.provisionWorkspace({
        tenantId: "beta",
        workspaceId: "only",
        region: "us-east",
        operationId: "beta:only",
      });
      expect(await control.getWorkspace("beta", alphaWorkspaceId)).toBeNull();

      await control.rotateWorkspaceCredentials({
        tenantId: "alpha",
        workspaceId: alphaWorkspaceId,
        rotationId: "shared-rotation-id",
      });
      await expect(control.rotateWorkspaceCredentials({
        tenantId: "beta",
        workspaceId: "only",
        rotationId: "shared-rotation-id",
      })).rejects.toThrow("identity_conflict");

      await control.createBackup({
        tenantId: "alpha",
        workspaceId: alphaWorkspaceId,
        backupId: "alpha-backup",
      });
      await expect(control.restoreBackup({
        tenantId: "beta",
        workspaceId: "only",
        backupId: "alpha-backup",
      })).rejects.toThrow("backup_not_restorable");

      const support = await control.grantSupportAccess({
        tenantId: "alpha",
        supportPrincipalId: "support:oncall",
        scope: "metadata",
        reason: "Tenant-scoped inspection",
        ticketRef: "ticket-isolation",
        lifetimeMs: 60_000,
      });
      expect(await control.hasSupportAccess({
        id: support.id,
        tenantId: "beta",
        supportPrincipalId: "support:oncall",
        scope: "metadata",
      })).toBeFalse();

      denied = "tenant.suspend";
      await expect(control.suspendTenant({
        tenantId: "beta",
        confirmation: "beta",
      })).rejects.toThrow("cloud_access_denied");
      expect((await control.getWorkspace("beta", "only"))?.status).toBe("ready");
      denied = null;

      await control.registerPrincipal({
        tenantId: "beta",
        principalId: "human:beta",
        kind: "human",
        issuer: "https://identity.example/",
        subject: "private-beta-subject",
        operationId: "principal:beta",
      });
      await control.enrollDevice({
        tenantId: "beta",
        principalId: "human:beta",
        deviceId: "device:beta",
        label: "Beta browser",
      });
      const session = await control.issueHumanSession({
        tenantId: "beta",
        issuer: "https://identity.example/",
        subject: "private-beta-subject",
        deviceId: "device:beta",
      });
      expect(await control.authenticateSession(session.token)).not.toBeNull();
      expect(await control.suspendTenant({
        tenantId: "beta",
        confirmation: "beta",
      })).toEqual({ tenantId: "beta", status: "suspended" });
      expect(await control.authenticateSession(session.token)).toBeNull();
      expect((await control.getWorkspace("beta", "only"))?.status).toBe("suspended");
      await expect(control.provisionWorkspace({
        tenantId: "beta",
        workspaceId: "after-suspension",
        region: "us-east",
        operationId: "beta:after-suspension",
      })).rejects.toThrow("tenant_not_active");
    } finally {
      control.close();
    }
    const bytes = (await readFile(databasePath)).toString("utf8");
    expect(bytes).not.toContain("private-beta-subject");
    expect(bytes).not.toContain(`secret:alpha:${alphaWorkspaceId}:v1`);
  });
});

function randomDecision(input: CloudAuthorizationRequest): string {
  return `decision:${input.action}:${crypto.randomUUID()}`;
}
