# TQ-705 — Local Console browser certification

> **Status:** certified on Linux and macOS — 2026-07-21
> **Machine certificate:** `TQ-705_CONSOLE_BROWSER_CERTIFICATION.json`

## Question

Can an operator trust the real local Console when the ledger is empty, mature,
hostile, internally corrupt or substantially larger than one browser page?

This gate certifies observable browser behavior. It does not turn bounded
operational health into a full integrity check, make loopback authentication,
or claim that local Console is a remote multi-user product.

## Deterministic fixture boundary

`packages/tasq-inspector/browser/console-fixture.ts` starts the production
Console server against five process-isolated SQLite stores. Every migration,
mutation, lease and HTTP response receives one fixed injected clock. The
fixture contains no device-clock read. Its bulk large-ledger setup writes
valid canonical rows and matching redacted audit events; it is setup data, not
a second runtime state store.

The Chromium suite executes these scenarios:

1. **Empty:** an established workspace with no commitments or audit events
   distinguishes absence from failure and exposes the one known actor.
2. **Mature:** open, running and blocked commitments, an active claim and an
   active opaque resource remain keyboard-readable, responsive, deeply
   inspectable, live-invalidated and HTTP read-only.
3. **Hostile:** actor-controlled markup stays inert, dialogs/scripts never
   execute, and private metadata is absent from both preview and JSON support
   artifacts.
4. **Corrupt:** a row that violates the canonical status contract produces a
   small generic HTTP 500 operator page without SQL, stack, path or corrupt
   value disclosure.
5. **Large:** 2,501 active commitments and matching audit events still return
   at most 100 records, use an exclusive keyset continuation, avoid duplicate
   rows, keep filtering explicitly page-local and bound the HTML response.

The 5-second first-render assertion is a coarse CI regression ceiling, not a
public latency SLA. Correctness budgets are the stable contract: 100 records
maximum per request, 256 KiB maximum initial HTML for the certified fixture,
32 KiB maximum corrupt-state error page and no unbounded browser-side dataset.

## Platform gate

The exact suite runs in real Chromium on both supported Local platforms:

- `console-browser` on `ubuntu-latest`;
- `console-browser-macos` on `macos-14`.

The existing full `verify` matrix remains separate. Keeping the original Linux
job name preserves branch-protection continuity while the macOS browser job
adds the second platform rather than weakening the first.

## What this proves — and does not

It proves the operator projection stays bounded, escaped, redacted and useful
across the five high-risk states on both supported OS families. It also proves
that corruption fails closed in the browser and that full integrity remains an
explicit `tasq doctor --tenant <workspace>` action.

It does not certify a hosted Console, authentication, remote access, every
browser engine, arbitrary ledger sizes or a latency SLA. Those require their
own product and deployment contracts.
