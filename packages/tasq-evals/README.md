# `@tasq-internal/evals`

Realistic, cross-layer agent and product journeys. Evals answer “does an
independent consumer experience the intended semantics?” rather than “does one
function return the expected value?”.

This workspace is private to the monorepo package graph and is never published.

## What belongs here

A good eval:

1. drives public or deliberately embedded surfaces through a realistic
   multi-step session;
2. asserts observable state, contracts and recovery behavior rather than
   implementation shortcuts;
3. uses injected authority time and isolated stores;
4. has a failure message that identifies the broken consumer promise.

Single-function and schema invariants belong with their owning package. CLI
single-command behavior belongs in `packages/tasq-cli/test/`. A connector
primitive needs SDK conformance tests plus one real adapter/kernel eval here.

## Current coverage

The top-level `*.test.ts` files cover:

- agent handoff, prioritization, collaboration, attempts and evidence;
- autonomous/cold-start onboarding, discovery, MCP capability selection and
  crash/reclaim contention;
- universal extension, connector and protocol interoperability;
- effects, dispatch authority, verified receipts and hostile recovery;
- outbox delivery, durable idempotency, replication conflicts and process-kill
  recovery;
- bounded/source-linked context and read-only observation loops;
- Local Console contracts, browser certification, public adoption and product
  support truth;
- package-installed interactive-runtime pause, crash, reclaim, multi-run and
  explicit-completion conformance;
- future hosted authority/store/REST foundations without claiming a deployable
  Server;
- documentation and public-roadmap consistency.

Use the filesystem as the exact inventory; documentation intentionally avoids
copying a long filename list that can go stale:

```bash
find packages/tasq-evals -maxdepth 1 -name '*.test.ts' -print | sort
```

## Run

```bash
# Complete eval workspace
pnpm --filter @tasq-internal/evals test

# One scenario; the package runner validates the filename
pnpm --filter @tasq-internal/evals test -- surface-compatibility.test.ts
```

The package runner executes files sequentially in fresh Bun processes. Several
scenarios build artifacts, start subprocesses and open native SQLite drivers;
parallel file execution is intentionally avoided for deterministic teardown.
Authenticated external-model trial runners are not part of ordinary CI and
their private transcripts are not stored in this standalone repository.
