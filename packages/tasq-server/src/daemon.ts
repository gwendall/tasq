#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import {
  backupTasqServer,
  bootstrapTasqServer,
  createRemoteEnrollmentAuthority,
  createTasqServerRuntime,
  loadTasqServerBootstrap,
  loadTasqServerConfig,
  openAuthorityStore,
  registeredActionIdentities,
  restoreTasqServerBackup,
} from "./index.js";

const clock = { now: () => Date.now() };

function value(args: string[], name: string): string {
  const index = args.indexOf(name);
  const found = index >= 0 ? args[index + 1] : undefined;
  if (!found || found.startsWith("--")) throw new Error(`${name} is required`);
  return found;
}

function pepper(): Uint8Array {
  const raw = process.env["TASQ_SERVER_ENROLLMENT_PEPPER"];
  if (!raw || !/^[A-Za-z0-9_-]{43,}$/.test(raw)) {
    throw new Error("TASQ_SERVER_ENROLLMENT_PEPPER must be a base64url secret containing at least 32 bytes");
  }
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.byteLength < 32 || decoded.toString("base64url") !== raw) {
    throw new Error("TASQ_SERVER_ENROLLMENT_PEPPER is not canonical base64url or is too short");
  }
  return decoded;
}

async function main() {
  const [command = "serve", ...args] = process.argv.slice(2);
  const configPath = resolve(value(args, "--config"));
  const config = await loadTasqServerConfig(configPath);
  if (command === "bootstrap") {
    const bootstrap = await loadTasqServerBootstrap(resolve(value(args, "--bootstrap")));
    const result = await bootstrapTasqServer({ config, bootstrap, clock });
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
    return;
  }
  if (command === "backup") {
    const manifest = await backupTasqServer({
      config,
      outputDirectory: resolve(value(args, "--output")),
      clock,
    });
    process.stdout.write(`${JSON.stringify({ status: "ok", manifest })}\n`);
    return;
  }
  if (command === "restore") {
    const manifest = await restoreTasqServerBackup({
      config,
      backupDirectory: resolve(value(args, "--input")),
    });
    process.stdout.write(`${JSON.stringify({ status: "ok", manifest })}\n`);
    return;
  }
  if (command === "enroll") {
    const workspaceId = value(args, "--workspace");
    const principalId = value(args, "--principal");
    const subject = value(args, "--subject");
    const clientKind = value(args, "--client-kind");
    if (clientKind !== "human_device" && clientKind !== "workload_agent") {
      throw new Error("--client-kind must be human_device or workload_agent");
    }
    const store = await openAuthorityStore({ url: config.authorityDatabaseUrl, clock });
    try {
      const state = await store.getWorkspaceAuthorityState(workspaceId);
      if (!state || state.status !== "enabled") throw new Error("workspace is missing or disabled");
      const authority = createRemoteEnrollmentAuthority({
        store,
        clock,
        pepper: pepper(),
        issuer: config.enrollment.issuer,
        audience: config.publicUrl,
      });
      const now = clock.now();
      const enrollment = await authority.create({
        workspaceId,
        principalId,
        subject,
        clientKind,
        actionUpperBound: registeredActionIdentities(),
        enrollmentExpiresAt: now + 15 * 60 * 1_000,
        accessExpiresAt: now + config.enrollment.accessLifetimeMs,
        context: {
          operationId: `operator-enrollment:${randomUUID()}`,
          actorPrincipalId: "self-host-operator",
          reason: "operator-created one-use remote enrollment",
          expectedAuthorityRevision: state.authorityRevision,
        },
      });
      process.stdout.write(`${JSON.stringify({
        status: "ok",
        workspaceId,
        enrollmentToken: enrollment.enrollmentToken,
        enrollmentExpiresAt: enrollment.enrollmentExpiresAt,
        accessExpiresAt: enrollment.accessExpiresAt,
      })}\n`);
    } finally {
      await store.close();
    }
    return;
  }
  if (command === "revoke-credential") {
    const workspaceId = value(args, "--workspace");
    const credentialId = value(args, "--credential");
    const expectedCredentialRevision = Number(value(args, "--expected-revision"));
    if (!Number.isSafeInteger(expectedCredentialRevision) || expectedCredentialRevision < 1) {
      throw new Error("--expected-revision must be a positive integer");
    }
    const store = await openAuthorityStore({ url: config.authorityDatabaseUrl, clock });
    try {
      const state = await store.getWorkspaceAuthorityState(workspaceId);
      if (!state || state.status !== "enabled") throw new Error("workspace is missing or disabled");
      const result = await store.revokeAccessCredential({
        workspaceId,
        credentialId,
        expectedCredentialRevision,
        context: {
          operationId: `operator-credential-revocation:${randomUUID()}`,
          actorPrincipalId: "self-host-operator",
          reason: "operator-revoked remote access credential",
          expectedAuthorityRevision: state.authorityRevision,
        },
      });
      process.stdout.write(`${JSON.stringify({ status: "ok", result })}\n`);
    } finally {
      await store.close();
    }
    return;
  }
  if (command === "revoke-grant") {
    const workspaceId = value(args, "--workspace");
    const grantId = value(args, "--grant");
    const expectedGrantRevision = Number(value(args, "--expected-revision"));
    if (!Number.isSafeInteger(expectedGrantRevision) || expectedGrantRevision < 1) {
      throw new Error("--expected-revision must be a positive integer");
    }
    const store = await openAuthorityStore({ url: config.authorityDatabaseUrl, clock });
    try {
      const state = await store.getWorkspaceAuthorityState(workspaceId);
      if (!state || state.status !== "enabled") throw new Error("workspace is missing or disabled");
      const result = await store.revokeGrant({
        workspaceId,
        grantId,
        expectedGrantRevision,
        context: {
          operationId: `operator-grant-revocation:${randomUUID()}`,
          actorPrincipalId: "self-host-operator",
          reason: "operator-revoked live authorization grant",
          expectedAuthorityRevision: state.authorityRevision,
        },
      });
      process.stdout.write(`${JSON.stringify({ status: "ok", result })}\n`);
    } finally {
      await store.close();
    }
    return;
  }
  if (command !== "serve" && command !== "check") throw new Error(`unknown command: ${command}`);
  const runtime = await createTasqServerRuntime({
    config,
    enrollmentPepper: pepper(),
    clock,
  });
  if (command === "check") {
    await runtime.close();
    process.stdout.write(`${JSON.stringify({ status: "ok", workspaces: config.workspaces.length })}\n`);
    return;
  }
  const server = Bun.serve({
    hostname: config.listen.host,
    port: config.listen.port,
    fetch: runtime.fetch,
  });
  process.stdout.write(`${JSON.stringify({
    contractVersion: "tasq.server-announcement.v1",
    status: "ready",
    publicUrl: config.publicUrl,
    listen: `http://${config.listen.host}:${server.port}`,
    workspaces: config.workspaces.length,
    pid: process.pid,
  })}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.stop();
    await runtime.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: "tasq_server_failed",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
