import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedConnectorObservation } from "@tasq-run/extension-sdk";
import {
  ExternalRefInsert,
  canonicalizeEffectJson,
  type ExternalRefInsert as ExternalRefInsertValue,
} from "@tasq-run/schema";
import { z } from "zod";

export const GITHUB_BRIDGE_CONTRACT_VERSION = "tasq.github-bridge.v1" as const;
export const GITHUB_SYSTEM_URI = "https://github.com/" as const;
const MAX_WEBHOOK_BYTES = 1_048_576;
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Repository = z.object({
  id: z.number().int().positive(),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
  html_url: z.string().url(),
}).passthrough();
const User = z.object({ id: z.number().int().positive(), login: z.string().min(1).max(100) }).passthrough();
const Common = z.object({
  action: z.string().min(1).max(80),
  repository: Repository,
  sender: User,
}).passthrough();

const GitHubRepositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201);
export const GitHubFeedbackReport = z.object({
  id: z.string().uuid(),
  summary: z.string().trim().min(1).max(500).refine((value) => !/[\r\n]/.test(value), "summary must be one line"),
  details: z.string().trim().min(1).max(10_000).nullable(),
  capturedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  context: z.object({
    version: z.string().min(1).max(100),
    platform: z.string().min(1).max(100),
    architecture: z.string().min(1).max(100),
    previousFailure: z.object({
      command: z.string().min(1).max(100),
      subcommand: z.string().min(1).max(100).nullable(),
      flags: z.array(z.string().regex(/^[A-Za-z0-9-]{1,100}$/)).max(100),
      exitCode: z.number().int().min(1).max(255),
      recordedAt: z.number().int().nonnegative(),
    }).strict().nullable(),
  }).strict(),
}).strict();
export type GitHubFeedbackReport = z.infer<typeof GitHubFeedbackReport>;

export interface GitHubFeedbackPublication {
  disposition: "created" | "existing";
  repository: string;
  issueNumber: number;
  issueUrl: string;
  marker: string;
  completionMapping: "none";
}

export type GitHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function feedbackHeaders(token: string): HeadersInit {
  if (!token.trim()) throw new Error("GitHub token is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "tasq-feedback",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function feedbackMarker(id: string): string {
  return `<!-- tasq-feedback:${id} -->`;
}

export function parseGitHubRepositoryName(value: string): string {
  return GitHubRepositoryName.parse(value);
}

export function githubFeedbackIssueBody(reportInput: GitHubFeedbackReport): {
  title: string;
  body: string;
  marker: string;
} {
  const report = GitHubFeedbackReport.parse(reportInput);
  const marker = feedbackMarker(report.id);
  const previous = report.context.previousFailure;
  const command = previous
    ? `\`${previous.command}${previous.subcommand ? ` ${previous.subcommand}` : ""}\` (exit ${previous.exitCode}; flags: ${previous.flags.length > 0 ? previous.flags.map((flag) => `\`--${flag}\``).join(", ") : "none"})`
    : "No prior failed command was recorded.";
  const body = [
    report.details ? `## Details\n\n${report.details}` : null,
    "## Captured context",
    "",
    `- Tasq: \`${report.context.version}\``,
    `- Platform: \`${report.context.platform}/${report.context.architecture}\``,
    `- Previous failure: ${command}`,
    `- Captured: \`${new Date(report.capturedAt).toISOString()}\``,
    "",
    "This report was captured locally and pushed explicitly with `tasq feedback push`.",
    "GitHub activity is observational only and never completes a Tasq commitment.",
    "",
    marker,
  ].filter((line): line is string => line !== null).join("\n");
  return { title: Array.from(`[tasq feedback] ${report.summary}`).slice(0, 256).join(""), body, marker };
}

/**
 * Publish one explicit local report. The hidden report marker lets retries
 * reconcile an already-created issue before attempting another create.
 */
export async function publishGitHubFeedbackIssue(input: {
  repository: string;
  token: string;
  report: GitHubFeedbackReport;
  fetch?: GitHubFetch;
  signal?: AbortSignal;
}): Promise<GitHubFeedbackPublication> {
  const repository = parseGitHubRepositoryName(input.repository);
  const report = GitHubFeedbackReport.parse(input.report);
  const request = githubFeedbackIssueBody(report);
  const fetcher: GitHubFetch = input.fetch ?? globalThis.fetch;
  const headers = feedbackHeaders(input.token);
  const signal = input.signal ?? AbortSignal.timeout(30_000);
  const query = encodeURIComponent(`repo:${repository} is:issue in:body \"tasq-feedback:${report.id}\"`);
  const searched = await fetcher(`https://api.github.com/search/issues?q=${query}&per_page=10`, { headers, signal });
  if (!searched.ok) throw new Error(`GitHub feedback reconciliation failed (${searched.status})`);
  const searchPayload = z.object({
    items: z.array(z.object({
      number: z.number().int().positive(),
      html_url: z.string().url(),
      body: z.string().nullable(),
    }).passthrough()).max(10),
  }).passthrough().parse(await searched.json());
  const existing = searchPayload.items.find((item) => item.body?.includes(request.marker));
  if (existing) {
    return {
      disposition: "existing",
      repository,
      issueNumber: existing.number,
      issueUrl: githubUrl(existing.html_url, "issue.html_url"),
      marker: request.marker,
      completionMapping: "none",
    };
  }

  const [owner, name] = repository.split("/");
  const created = await fetcher(`https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/issues`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ title: request.title, body: request.body }),
  });
  if (created.status !== 201) throw new Error(`GitHub feedback publication failed (${created.status})`);
  const payload = z.object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    body: z.string().nullable(),
  }).passthrough().parse(await created.json());
  if (!payload.body?.includes(request.marker)) throw new Error("GitHub feedback response omitted the idempotency marker");
  return {
    disposition: "created",
    repository,
    issueNumber: payload.number,
    issueUrl: githubUrl(payload.html_url, "issue.html_url"),
    marker: request.marker,
    completionMapping: "none",
  };
}

export const GitHubFieldAuthority = z.object({
  title: z.enum(["github", "tasq", "none"]),
  body: z.enum(["github", "tasq", "none"]),
  labels: z.enum(["github", "tasq", "none"]),
  assignees: z.enum(["github", "tasq", "none"]),
  discussion: z.literal("github"),
  issueState: z.literal("github_observation_only"),
  commitmentStatus: z.literal("tasq"),
  completion: z.literal("tasq_resolution_only"),
  conflictPolicy: z.literal("reject_no_last_write_wins"),
}).strict();
export type GitHubFieldAuthority = z.infer<typeof GitHubFieldAuthority>;

export function defineGitHubFieldAuthority(input: GitHubFieldAuthority): Readonly<GitHubFieldAuthority> {
  return Object.freeze(GitHubFieldAuthority.parse(input));
}

function githubUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== "https://github.com" || url.username || url.password) {
    throw new Error(`${label} must be a credential-free https://github.com URL`);
  }
  return url.href;
}

export function githubIssueExternalRef(input: {
  workspaceId: string;
  commitmentId: string;
  repository: string;
  issueNumber: number;
  issueNodeId: string;
  issueUrl: string;
  fieldAuthority: GitHubFieldAuthority;
}): ExternalRefInsertValue {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error("repository must be owner/name");
  }
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error("issueNumber must be a positive integer");
  }
  const authority = defineGitHubFieldAuthority(input.fieldAuthority);
  return ExternalRefInsert.parse({
    tenantId: input.workspaceId,
    recordType: "commitment",
    recordId: input.commitmentId,
    system: GITHUB_SYSTEM_URI,
    resourceType: "github.issue",
    externalId: input.issueNodeId,
    url: githubUrl(input.issueUrl, "issueUrl"),
    version: null,
    digest: `sha256:${createHash("sha256").update(canonicalizeEffectJson({
      repository: input.repository,
      issueNumber: input.issueNumber,
      issueNodeId: input.issueNodeId,
      fieldAuthority: authority,
    })).digest("hex")}`,
    metadata: {
      bridgeContract: GITHUB_BRIDGE_CONTRACT_VERSION,
      repository: input.repository,
      issueNumber: input.issueNumber,
      fieldAuthority: authority,
      completionMapping: "none",
    },
  });
}

function header(headers: Headers | Record<string, string | undefined>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? null;
}

function verifySignature(secret: string | Uint8Array, body: Uint8Array, supplied: string): void {
  if (!/^sha256=[0-9a-f]{64}$/.test(supplied)) throw new Error("invalid GitHub signature header");
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("GitHub webhook signature mismatch");
  }
}

function isoMs(value: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("invalid GitHub timestamp");
  return result;
}

function objectDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}`;
}

type Normalized = { type: "issue" | "pull_request" | "check_run" | "deployment"; payload: Record<string, unknown>; occurredAt: number; rawRef: string };

function normalize(event: string, raw: unknown): Normalized {
  const base = Common.parse(raw);
  const repositoryUrl = githubUrl(base.repository.html_url, "repository.html_url");
  if (event === "issues") {
    const parsed = Common.extend({
      issue: z.object({
        id: z.number().int().positive(),
        node_id: z.string().min(1).max(200),
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        state_reason: z.string().max(80).nullable().optional(),
        title: z.string().max(10_000),
        html_url: z.string().url(),
        updated_at: z.string(),
        labels: z.array(z.object({ name: z.string().max(100) }).passthrough()).max(100),
        assignees: z.array(User).max(100),
      }).passthrough(),
    }).parse(raw);
    return {
      type: "issue",
      occurredAt: isoMs(parsed.issue.updated_at),
      rawRef: githubUrl(parsed.issue.html_url, "issue.html_url"),
      payload: {
        action: parsed.action,
        repository: parsed.repository.full_name,
        repositoryId: parsed.repository.id,
        issueId: parsed.issue.id,
        issueNodeId: parsed.issue.node_id,
        issueNumber: parsed.issue.number,
        state: parsed.issue.state,
        stateReason: parsed.issue.state_reason ?? null,
        titleDigest: objectDigest(parsed.issue.title),
        labels: parsed.issue.labels.map(({ name }) => name).sort(),
        assignees: parsed.issue.assignees.map(({ id, login }) => ({ id, login })).sort((a, b) => a.id - b.id),
        sender: { id: parsed.sender.id, login: parsed.sender.login },
        completionMapping: "none",
      },
    };
  }
  if (event === "pull_request") {
    const parsed = Common.extend({
      pull_request: z.object({
        id: z.number().int().positive(),
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        merged: z.boolean(),
        html_url: z.string().url(),
        updated_at: z.string(),
        head: z.object({ sha: Sha }).passthrough(),
        base: z.object({ sha: Sha }).passthrough(),
      }).passthrough(),
    }).parse(raw);
    return {
      type: "pull_request",
      occurredAt: isoMs(parsed.pull_request.updated_at),
      rawRef: githubUrl(parsed.pull_request.html_url, "pull_request.html_url"),
      payload: {
        action: parsed.action,
        repository: parsed.repository.full_name,
        repositoryId: parsed.repository.id,
        pullRequestId: parsed.pull_request.id,
        pullRequestNumber: parsed.pull_request.number,
        state: parsed.pull_request.state,
        merged: parsed.pull_request.merged,
        headSha: parsed.pull_request.head.sha,
        baseSha: parsed.pull_request.base.sha,
        completionMapping: "none",
      },
    };
  }
  if (event === "check_run") {
    const parsed = Common.extend({
      check_run: z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(500),
        status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
        conclusion: z.string().max(80).nullable(),
        html_url: z.string().url(),
        head_sha: Sha,
        completed_at: z.string().nullable(),
        started_at: z.string().nullable(),
      }).passthrough(),
    }).parse(raw);
    return {
      type: "check_run",
      occurredAt: isoMs(parsed.check_run.completed_at ?? parsed.check_run.started_at ?? new Date(0).toISOString()),
      rawRef: githubUrl(parsed.check_run.html_url, "check_run.html_url"),
      payload: {
        action: parsed.action,
        repository: parsed.repository.full_name,
        checkRunId: parsed.check_run.id,
        name: parsed.check_run.name,
        status: parsed.check_run.status,
        conclusion: parsed.check_run.conclusion,
        headSha: parsed.check_run.head_sha,
        completionMapping: "none",
      },
    };
  }
  if (event === "deployment_status") {
    const parsed = Common.extend({
      deployment: z.object({
        id: z.number().int().positive(),
        sha: Sha,
        environment: z.string().min(1).max(500),
      }).passthrough(),
      deployment_status: z.object({
        id: z.number().int().positive(),
        state: z.string().min(1).max(80),
        target_url: z.string().url().nullable().optional(),
        created_at: z.string(),
      }).passthrough(),
    }).parse(raw);
    return {
      type: "deployment",
      occurredAt: isoMs(parsed.deployment_status.created_at),
      rawRef: repositoryUrl,
      payload: {
        action: parsed.action,
        repository: parsed.repository.full_name,
        deploymentId: parsed.deployment.id,
        deploymentStatusId: parsed.deployment_status.id,
        sha: parsed.deployment.sha,
        environment: parsed.deployment.environment,
        state: parsed.deployment_status.state,
        targetUrlDigest: parsed.deployment_status.target_url ? objectDigest(parsed.deployment_status.target_url) : null,
        completionMapping: "none",
      },
    };
  }
  throw new Error(`unsupported GitHub event: ${event}`);
}

export function verifyAndNormalizeGitHubWebhook(input: {
  secret: string | Uint8Array;
  headers: Headers | Record<string, string | undefined>;
  rawBody: string | Uint8Array;
  receivedAt: number;
}): NormalizedConnectorObservation {
  const body = typeof input.rawBody === "string" ? new TextEncoder().encode(input.rawBody) : input.rawBody;
  if (body.byteLength === 0 || body.byteLength > MAX_WEBHOOK_BYTES) throw new Error("GitHub webhook body size is invalid");
  const signature = header(input.headers, "x-hub-signature-256");
  const event = header(input.headers, "x-github-event");
  const delivery = header(input.headers, "x-github-delivery");
  if (!signature || !event || !delivery || !/^[0-9a-f-]{16,64}$/i.test(delivery)) {
    throw new Error("GitHub webhook identity headers are missing or invalid");
  }
  if (!Number.isSafeInteger(input.receivedAt) || input.receivedAt < 0) throw new Error("receivedAt is invalid");
  verifySignature(input.secret, body, signature);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("GitHub webhook body is not valid UTF-8 JSON");
  }
  const normalized = normalize(event, raw);
  const rawDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return {
    source: "github:webhook",
    externalEventId: `github-delivery:${delivery.toLowerCase()}`,
    typeUri: `https://tasq.run/types/github/${normalized.type}.v1`,
    schemaVersion: 1,
    payload: normalized.payload as never,
    occurredAt: normalized.occurredAt,
    verificationLevel: "authenticated_source",
    verificationMethod: "github-webhook-hmac-sha256",
    rawRef: normalized.rawRef,
    digest: rawDigest,
    metadata: {
      bridgeContract: GITHUB_BRIDGE_CONTRACT_VERSION,
      event,
      receivedAt: input.receivedAt,
      completionMapping: "none",
    },
  };
}
