# TQ-633 — npm default-tag safety

Status: complete; the supported protected `v0.4.0` release is the npm default.

## Problem

An unsupported bootstrap version is allowed to create a package identity, but
it must never become the default install. The safety property is about the
registry's current dist-tag state, not the `--tag` argument that a publisher
intended to send.

At `2026-08-11T14:16:24Z`, after protected release run
[31497848901](https://github.com/gwendall/tasq/actions/runs/31497848901), the
anonymous command `npm view @tasq-run/client versions dist-tags time --json`
showed `alpha-bootstrap=0.1.0-alpha.0` and `latest=0.4.0`. The unsupported
bootstrap remains explicitly addressable but is no longer the default install.

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

## Completion evidence

The allowed replacement path was used: protected OIDC publication installed
the exact supported `v0.4.0` artifact as `latest`. An anonymous registry read
now shows:

```bash
npm view @tasq-run/client versions dist-tags time --json
```

- `alpha-bootstrap = 0.1.0-alpha.0`; and
- `latest = 0.4.0`.

TQ-633 is therefore complete. The protected workflow still fails unless every
authorized public package's `latest` tag resolves to its exact release version.

Machine-readable observation and acceptance state:
[`TQ-633_NPM_DEFAULT_TAG_SAFETY.json`](TQ-633_NPM_DEFAULT_TAG_SAFETY.json).
