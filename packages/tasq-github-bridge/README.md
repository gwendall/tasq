# `@tasq-internal/github-bridge`

An external adapter for GitHub Issues and delivery webhooks. It does not put
GitHub schemas or credentials in Core.

- `defineGitHubFieldAuthority` freezes one owner per mirrored issue field.
- `githubIssueExternalRef` creates the immutable linkage input consumed by
  Core's `appendExternalRef`.
- `verifyAndNormalizeGitHubWebhook` verifies the exact raw request with
  HMAC-SHA256 and emits a bounded, secret-minimized issue, pull-request,
  check-run or deployment observation.

Issue state, merged pull requests, passing checks and successful deployments
are observations only. None completes a Tasq commitment. Discussion remains in
GitHub; completion remains in Tasq's resolution chain.
