import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  defineGitHubFieldAuthority,
  githubIssueExternalRef,
  verifyAndNormalizeGitHubWebhook,
} from "../src/index.js";

const secret = "webhook-secret";
const headers = (body: string, event: string, delivery = "123e4567-e89b-12d3-a456-426614174000") => ({
  "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  "x-github-event": event,
  "x-github-delivery": delivery,
});
const common = {
  action: "closed",
  repository: { id: 1, full_name: "acme/launch", html_url: "https://github.com/acme/launch" },
  sender: { id: 2, login: "octo" },
};

describe("TQ-812 GitHub bridge", () => {
  test("freezes explicit one-owner field authority in an immutable issue link", () => {
    const fieldAuthority = defineGitHubFieldAuthority({
      title: "tasq",
      body: "github",
      labels: "github",
      assignees: "none",
      discussion: "github",
      issueState: "github_observation_only",
      commitmentStatus: "tasq",
      completion: "tasq_resolution_only",
      conflictPolicy: "reject_no_last_write_wins",
    });
    const link = githubIssueExternalRef({
      workspaceId: "team/acme",
      commitmentId: "018f47c2-7c80-7000-8000-000000000001",
      repository: "acme/launch",
      issueNumber: 42,
      issueNodeId: "I_kwDOA",
      issueUrl: "https://github.com/acme/launch/issues/42",
      fieldAuthority,
    });
    expect(link).toMatchObject({
      system: "https://github.com/",
      resourceType: "github.issue",
      externalId: "I_kwDOA",
      metadata: { completionMapping: "none", fieldAuthority },
    });
    expect(link.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test.each([
    ["issues", {
      ...common,
      issue: {
        id: 10, node_id: "I_node", number: 42, state: "closed", state_reason: "completed",
        title: "Do not copy this title", html_url: "https://github.com/acme/launch/issues/42",
        updated_at: "2026-07-24T09:00:00Z", labels: [{ name: "ready" }], assignees: [{ id: 2, login: "octo" }],
      },
    }, "issue"],
    ["pull_request", {
      ...common,
      pull_request: {
        id: 11, number: 43, state: "closed", merged: true,
        html_url: "https://github.com/acme/launch/pull/43", updated_at: "2026-07-24T09:01:00Z",
        head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) },
      },
    }, "pull_request"],
    ["check_run", {
      ...common,
      check_run: {
        id: 12, name: "test", status: "completed", conclusion: "success",
        html_url: "https://github.com/acme/launch/runs/12", head_sha: "a".repeat(40),
        started_at: "2026-07-24T09:00:00Z", completed_at: "2026-07-24T09:02:00Z",
      },
    }, "check_run"],
    ["deployment_status", {
      ...common,
      deployment: { id: 13, sha: "a".repeat(40), environment: "production" },
      deployment_status: {
        id: 14, state: "success", target_url: "https://prod.example/",
        created_at: "2026-07-24T09:03:00Z",
      },
    }, "deployment"],
  ])("authenticates and normalizes %s without mapping completion", (event, payload, kind) => {
    const body = JSON.stringify(payload);
    const result = verifyAndNormalizeGitHubWebhook({
      secret,
      headers: headers(body, event),
      rawBody: body,
      receivedAt: Date.parse("2026-07-24T09:04:00Z"),
    });
    expect(result.typeUri).toBe(`https://tasq.run/types/github/${kind}.v1`);
    expect(result.verificationMethod).toBe("github-webhook-hmac-sha256");
    expect(result.metadata).toMatchObject({ completionMapping: "none" });
    expect(result.payload).toMatchObject({ completionMapping: "none" });
  });

  test("rejects tampering, foreign URLs and unsupported events before observation", () => {
    const body = JSON.stringify({
      ...common,
      issue: {
        id: 10, node_id: "I_node", number: 42, state: "open", title: "x",
        html_url: "https://evil.example/issues/42", updated_at: "2026-07-24T09:00:00Z",
        labels: [], assignees: [],
      },
    });
    expect(() => verifyAndNormalizeGitHubWebhook({
      secret,
      headers: headers(`${body}x`, "issues"),
      rawBody: body,
      receivedAt: 1,
    })).toThrow("signature mismatch");
    expect(() => verifyAndNormalizeGitHubWebhook({
      secret,
      headers: headers(body, "issues"),
      rawBody: body,
      receivedAt: 1,
    })).toThrow("https://github.com");
    const unsupported = JSON.stringify(common);
    expect(() => verifyAndNormalizeGitHubWebhook({
      secret,
      headers: headers(unsupported, "push"),
      rawBody: unsupported,
      receivedAt: 1,
    })).toThrow("unsupported GitHub event");
  });
});
