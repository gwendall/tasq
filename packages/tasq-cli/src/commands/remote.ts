import {
  createRemoteTasq,
  redeemRemoteEnrollment,
  TasqRemoteError,
} from "@tasq-run/client";
import type { Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { printInfo, printJson } from "../output/format.js";
import {
  hasRemoteProfile,
  loadRemoteProfile,
  removeRemoteProfile,
  saveRemoteProfile,
} from "../remote-profile.js";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function profileName(args: ParsedArgs): string {
  return args.string("profile") ?? "default";
}

function clientFor(args: ParsedArgs) {
  const profile = loadRemoteProfile(profileName(args));
  return {
    profile,
    client: createRemoteTasq({
      endpoint: profile.endpoint,
      workspaceId: profile.workspaceId,
      accessToken: profile.accessToken,
    }),
  };
}

function humanError(error: unknown): never {
  if (error instanceof TasqRemoteError) {
    const recovery = error.code === "cursor_expired" && error.oldestSequence !== null
      ? `; oldest retained sequence is ${error.oldestSequence}`
      : "";
    throw new Error(`Remote ${error.code} (HTTP ${error.status})${recovery}`);
  }
  throw error;
}

export async function remoteCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const subcommand = args.positional[0] ?? "status";
  const json = args.bool("json", "j");
  try {
    if (subcommand === "enroll") {
      const name = profileName(args);
      const token = args.string("token") ?? process.env.TASQ_ENROLLMENT_TOKEN;
      if (!token) {
        throw new Error("Missing enrollment token; set TASQ_ENROLLMENT_TOKEN or pass --token");
      }
      const endpoint = required(args.string("endpoint"), "endpoint");
      const workspaceId = required(args.string("workspace"), "workspace");
      if (hasRemoteProfile(name) && !args.bool("replace")) {
        throw new Error(`Remote profile "${name}" already exists; use --replace to rotate it`);
      }
      const enrolled = await redeemRemoteEnrollment({ endpoint, workspaceId, enrollmentToken: token });
      const path = saveRemoteProfile({
        contractVersion: "tasq.remote-profile.v1",
        name,
        endpoint,
        workspaceId,
        credentialId: enrolled.credentialId,
        principalId: enrolled.principalId,
        clientKind: enrolled.clientKind,
        accessToken: enrolled.accessToken,
        issuedAt: enrolled.issuedAt,
        expiresAt: enrolled.expiresAt,
        actionUpperBound: enrolled.actionUpperBound,
      }, args.bool("replace"));
      const output = {
        contractVersion: "tasq.remote-enrollment-result.v1",
        profile: name,
        endpoint,
        workspaceId,
        principalId: enrolled.principalId,
        credentialId: enrolled.credentialId,
        expiresAt: enrolled.expiresAt,
        profilePath: path,
      };
      if (json) printJson(output);
      else printInfo(`Enrolled ${name} as ${enrolled.principalId} in ${workspaceId}\nCredential saved privately at ${path}`);
      return 0;
    }

    if (subcommand === "logout") {
      const name = profileName(args);
      const removed = removeRemoteProfile(name);
      const output = {
        contractVersion: "tasq.remote-logout-result.v1",
        profile: name,
        removed,
        serverCredentialRevoked: false,
      };
      if (json) printJson(output);
      else printInfo(removed
        ? `Removed local remote profile "${name}". Server revocation is a separate administrator action.`
        : `Remote profile "${name}" was already absent.`);
      return 0;
    }

    const { profile, client } = clientFor(args);
    if (subcommand === "status") {
      const output = {
        contractVersion: "tasq.remote-status.v1",
        profile: profile.name,
        endpoint: profile.endpoint,
        workspaceId: profile.workspaceId,
        principalId: profile.principalId,
        credentialId: profile.credentialId,
        clientKind: profile.clientKind,
        expiresAt: profile.expiresAt,
        expired: clock.now() >= profile.expiresAt,
        actionUpperBound: profile.actionUpperBound,
      };
      if (json) printJson(output);
      else printInfo(`${profile.name}: ${profile.principalId} → ${profile.workspaceId} at ${profile.endpoint}`);
      return 0;
    }
    if (subcommand === "list") {
      const page = await client.listCommitments({
        cursor: args.string("cursor") ?? null,
        limit: args.number("limit"),
      });
      if (json) printJson(page);
      else for (const item of page.items) printInfo(`${item.id}\t${item.status}\t${item.title}`);
      return 0;
    }
    if (subcommand === "show") {
      const id = args.positional[1];
      if (!id) throw new Error("Usage: tasq remote show <commitment-id>");
      const result = await client.getCommitment(id);
      if (json) printJson(result);
      else printInfo(`${result.item.id}\t${result.item.status}\t${result.item.title}`);
      return 0;
    }
    if (subcommand === "events") {
      const page = await client.listEvents({
        afterSequence: args.number("after-sequence") ?? 0,
        limit: args.number("limit"),
      });
      if (json) printJson(page);
      else for (const event of page.items) {
        printInfo(`${event.sequence}\t${event.eventType}\t${event.entityType}:${event.entityId}`);
      }
      return 0;
    }
    if (subcommand === "operations") {
      const catalog = await client.listOperations();
      if (json) printJson(catalog);
      else for (const operation of catalog.operations) printInfo(`${operation.id}\t${operation.summary}`);
      return 0;
    }
    if (subcommand === "call") {
      const operationId = args.positional[1];
      if (!operationId) throw new Error("Usage: tasq remote call <operation-id> [flags]");
      const resourceKind = required(args.string("resource-kind"), "resource-kind") as
        "workspace" | "commitment" | "resource" | "effect" | "replica";
      const resourceId = required(args.string("resource-id"), "resource-id");
      const key = required(args.string("idempotency-key"), "idempotency-key");
      const rawInput = args.string("input") ?? "{}";
      let input: unknown;
      try {
        input = JSON.parse(rawInput);
      } catch {
        throw new Error("--input must be valid JSON");
      }
      const outcome = await client.executeOperation(operationId, {
        resource: { kind: resourceKind, id: resourceId },
        expectedRevision: args.number("expected-revision") ?? null,
        input,
        idempotencyKey: key,
        requestId: args.string("request-id"),
      });
      if (json) printJson(outcome);
      else printInfo(`${outcome.resultType}:${outcome.resultId}${outcome.replayed ? " (replay)" : ""}`);
      return 0;
    }
    throw new Error(`Unknown remote command: ${subcommand}`);
  } catch (error) {
    humanError(error);
  }
}
