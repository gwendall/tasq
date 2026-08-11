# TQ-633 — npm default-tag safety

Status: source candidate complete; external registry remediation required.

## Problem

An unsupported bootstrap version is allowed to create a package identity, but
it must never become the default install. The safety property is about the
registry's current dist-tag state, not the `--tag` argument that a publisher
intended to send.

At `2026-08-11T02:57:46Z`, the anonymous public command
`npm view @tasq-run/client versions dist-tags time --json` returned one version,
`0.1.0-alpha.0`, with both `alpha-bootstrap` and `latest` resolving to it. The
bootstrap has no published-support grant. Therefore a default
`npm install @tasq-run/client` is currently unsafe and no source-only change can
claim that the public registry was repaired.

## Source controls

The one-shot client bootstrap and protected release share one non-cancelling
publication concurrency group. After byte verification, the bootstrap:

1. proves `alpha-bootstrap` resolves to the exact bootstrap version;
2. removes `latest` only when it resolves to that exact bootstrap version;
3. re-reads public dist-tags and fails unless `alpha-bootstrap` remains exact
   and `latest` no longer resolves to the bootstrap.

The protected release re-reads every authorized public package after publish
and fails unless `latest` resolves to its exact release version. These checks
do not infer support from package existence or provenance.

## Remaining external gate

An authenticated npm package owner must now either remove `latest` from
`@tasq-run/client@0.1.0-alpha.0` or replace it by publishing the exact supported
`v0.4.0` artifact through the protected workflow. Afterwards, an anonymous
registry read must show:

```bash
npm dist-tag rm @tasq-run/client latest
npm view @tasq-run/client versions dist-tags time --json
```

The first command is the minimal immediate remediation. It requires npm owner
authority and is intentionally not treated as complete until the second,
anonymous read proves the public state.

- `alpha-bootstrap = 0.1.0-alpha.0`; and
- `latest` absent or equal to the exact supported release, never the bootstrap.

Until that evidence exists, TQ-633 stays
`candidate_done_external_gate` and default-install support claims remain
blocked. Publishing the exact supported `v0.4.0` through the protected
workflow is itself an allowed remediation because its postcondition requires
`latest` to resolve to those exact bytes.

Machine-readable observation and acceptance state:
[`TQ-633_NPM_DEFAULT_TAG_SAFETY.json`](TQ-633_NPM_DEFAULT_TAG_SAFETY.json).
