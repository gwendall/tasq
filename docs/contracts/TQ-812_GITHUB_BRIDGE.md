# TQ-812 — GitHub bridge

> **Status:** done
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-812_GITHUB_BRIDGE_CERTIFICATION.json`

`@tasq-internal/github-bridge` is an adapter outside Core. It freezes explicit
authority for title, body, labels and assignees while reserving discussion and
issue state to GitHub observation and commitment status/completion to Tasq.
The conflict rule is rejection, never last-write-wins.

`githubIssueExternalRef` returns a validated Core `ExternalRefInsert`. The link
pins the GitHub node identity, credential-free `github.com` URL, repository,
issue number, field policy and their digest. Core appends that link
immutably.

`verifyAndNormalizeGitHubWebhook`:

- bounds the exact raw request to 1 MiB;
- verifies `X-Hub-Signature-256` with constant-time comparison;
- binds the GitHub delivery and event headers;
- accepts only issue, pull-request, check-run and deployment-status shapes;
- pins references to `https://github.com`;
- hashes issue titles and deployment target URLs rather than copying them;
- emits authenticated, digest-bound normalized observations.

Closed issues, merged pull requests, successful checks and deployments never
complete a commitment. They may become evidence only through an explicit Tasq
resolution policy and validation decision.
