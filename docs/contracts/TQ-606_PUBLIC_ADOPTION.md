# TQ-606 — Blind public adoption gate

> **Status:** exact published-byte automation certified; independent-human
> evidence pending — 2026-07-23
> **Machine certificate:** `TQ-606_ADOPTION_CERTIFICATION.json`
> **Candidate pointers:** `/docs/getting-started/`, `/adopt.json` and
> `/product-truth.json`

## 1. Question

Can a consumer with no repository-specific briefing get from the product
entrypoint to useful collaboration between two independent actors,
recover contention and inspect the same ledger in the installed Console?

This is an adoption test, not another kernel unit test. Passing requires a
causal chain across explanation, acquisition, installed bytes, machine
onboarding, semantic operation selection, coordination and human inspection.

## 2. The pre-executable gap

`tasq onboard` already teaches an unknown agent everything it needs after it
has an executable pointer. Before TQ-606, a machine could see product status
without knowing a safe acquisition argv.

The deployed static site now generates `tasq.public-adoption.v1` at
`/adopt.json`. It
includes:

- immutable npm and GitHub release coordinates;
- exact Node, Bun and npm requirements;
- pinned package-runner, npm-prefix and checksum-authenticated native
  acquisition argv arrays;
- distinct working-directory placeholders;
- the explicit executable result;
- a bounded onboarding argv template for workspace and actor handoff;
- the authority, same-store, no-shell-reconstruction and no-device-time
  invariants required for safe use.

Its JSON Schema is served at
`/schemas/public-adoption.v1.schema.json`. Internal and public copies are
byte-identical and checked on every build. The generator fails closed if
published release policy lacks immutable coordinates or its versioned,
repository-pinned installer.

## 3. Published journey

`packages/tasq-evals/public-adoption.test.ts` consumes the downloaded,
attested native release in post-publication CI and installs it into an isolated
prefix.

The harness then copies only public contracts and package-independent clients
into separate temporary directories:

1. a Python human-shell proxy follows the public onboarding vector;
2. it reads bounded state and creates a neutral robotics commitment;
3. it acquires an opaque `robot:arm-a` resource with fence 1;
4. an unknown Node agent reads `/adopt.json`, constructs onboarding without a
   shell and selects recipes by output, mutation and parameter metadata;
5. the agent reads first and receives typed contention without touching the
   resource;
6. the human releases exact lease/fence/revision authority;
7. the agent retries under a new idempotency identity and receives fence 2;
8. it verifies the fence, claims and starts the commitment, appends synthetic
   evidence and requests explicit evidence-bound completion;
9. the installed foreground Console proves both actors, the completed
   commitment, the recovered resource and its runtime identity use the same
   ledger;
10. Console stop removes discovery and the agent releases its resource.

Neither client imports a Tasq package, knows a recipe identifier, reads the
repository or consults a device clock. The test itself uses no ambient clock.

## 4. What this proves

- public source consumers have a machine-actionable path before
  `tasq onboard`;
- human and agent consumers converge after one explicit store/workspace handoff;
- output/parameter metadata is sufficient for recipe selection;
- contention is actionable data rather than a generic error;
- explicit recovery advances the fence and invalidates stale authority;
- installed Console discovery and canonical reads observe the same ledger;
- no local HTML, agent prose or runtime result becomes mutation authority.

## 5. What remains external

The automated human-shell proxy proves that every documented step is complete
and executable for a published-artifact consumer. It cannot prove that a
real unfamiliar person understands the language, notices the warnings or
chooses correctly. That claim requires an independent blind human session with
no maintainer assistance after public-source launch.

Protected run
[30042551026](https://github.com/gwendall/tasq/actions/runs/30042551026)
has now rerun the journey from the exact attested `v0.2.0` release on both
supported targets. Final TQ-606 closure requires only one independent
unbriefed-human completion from the public entrypoint, including interventions
and failure points. Until that exists, the machine certificate keeps
`tq606Complete: false` and the backlog uses an external-gate candidate status.
