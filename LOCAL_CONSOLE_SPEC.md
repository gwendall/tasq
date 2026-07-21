# TQ-601 — Tasq Local Console product specification

> **Status:** accepted design baseline — 2026-07-20
> **Current implementation:** TQ-504 inspector plus TQ-701 canonical read models
> **Product contract:** `PRODUCT_CONSUMPTION_SPEC.md`

## 1. Purpose

The Local Console is the human operational view of **Tasq Local**. It helps a
person understand what agents and humans have committed to, who currently owns
work or scarce resources, what is waiting, what external effects need attention
and whether the local ledger is healthy.

It is not an agent API, a second source of truth, a workflow runtime, a generic
todo application or the public marketing site. Agents use the CLI JSON, MCP or
embedded Core contracts. The Console renders bounded projections from the same
canonical services those surfaces use.

## 2. Honest current baseline

`tasq web --tenant <space>` currently starts a server-rendered, read-only,
loopback-only inspector. It has bounded index and commitment graph routes,
JSON variants, strict Host checks, no JavaScript, no write route, no-store
responses and a script-free content security policy. Refresh is manual.

That inspector plus the TQ-701 JSON routes now provide bounded workspace-level
overview, actor, claim, resource, wait, effect, audit and operational-health
read models. The product still has no live stream, cross-workspace overview,
visual navigation, support bundle or remediation flow.

## 3. Users and jobs

| User | Primary job | Must be able to answer |
|---|---|---|
| Local human collaborator | Follow shared work | What is active, blocked, due, done or waiting? |
| Agent operator | Supervise autonomous work | Who holds each claim/resource, which attempts failed, what can safely retry? |
| Effect approver | Review consequential intent | What exact effect is proposed, under which authority, and what outcome is verified? |
| Local administrator | Preserve and recover the ledger | Is the store healthy, backed up, current and recoverable? |
| Integrator | Debug an adapter | Which immutable events, refs, receipts and cursors explain this state? |

## 4. Information architecture

The complete Local Console has seven bounded views:

1. **Overview** — counts and attention queues for active, waiting, blocked,
   contended and recently changed commitments.
2. **Work** — commitment list, dependency/relationship graph, assignment,
   claim, attempts, evidence, artifacts and completion basis.
3. **Agents and resources** — principals, active claims, generic resource
   leases, fences, contention and expiry.
4. **Waits and facts** — active waits, observations, candidate routing,
   reconciliations, deadline fallbacks and late facts.
5. **Effects** — exact proposals, revisions, approval chains, permits,
   dispatch attempts, receipts, uncertainty and compensation links.
6. **Audit** — cursor-addressed events and record histories with explicit
   provenance; never an inferred narrative that hides source records.
7. **Health** — version, schema/migration state, doctor findings, journal and
   backup posture, replication role and bounded support diagnostics.

Every aggregate links to its canonical records. Empty states distinguish
"none in this bounded current view" from "none ever existed" and expose the
appropriate history or pagination path.

## 5. Interaction contract

### 5.1 Read-only first

Local Console v1 remains read-only. Mutations stay in CLI/MCP/Core until there
is an authenticated server-side decision and authorization boundary. A browser
button must never manufacture authority from loopback access, actor-provided
content or a stale approval snapshot.

Useful actions may copy an argv recipe, record ID or cursor. They do not execute
it invisibly. Future mutations belong to Tasq Server and require the same
ADR-004 guard as REST and remote MCP.

### 5.2 Live monitoring

Live views use a bounded, cursor-driven stream. Server-sent events are the
preferred Local v1 transport; cursor-based polling is an acceptable fallback.
The contract requires:

- an initial bounded snapshot plus an exclusive resume cursor;
- monotone event delivery, explicit gaps and deterministic replay;
- reconnect from the last accepted cursor, including cursor-expiry recovery;
- bounded buffers, backpressure and a visible stale/disconnected state;
- no hidden client-side status machine that can outrank the ledger;
- redacted payloads and stable versioned event envelopes.

The server snapshots its injected `Clock` once per response or transaction.
Browser/device time may render relative durations as presentation only; it can
never decide expiry, ordering, approval validity, freshness or correctness.

### 5.3 Navigation and accessibility

All functions are keyboard reachable, focus order is stable, state is not
communicated by color alone and reduced-motion is honored. Tables degrade into
legible narrow layouts. Deep links identify workspace plus stable record ID;
filters and cursor position may be shareable without embedding credentials.

## 6. Data and authority boundaries

- No Console-owned domain table or shadow task state.
- All views call canonical service/query contracts and retain workspace scope.
- Lists are hard-bounded, paginated and stable under concurrent writes.
- User-authored strings are untrusted data and are escaped everywhere.
- Credentials, raw provider bodies and secret bindings are never rendered.
- Support bundles are explicit, previewable, redacted and generated locally.
- Local v1 binds only to loopback and validates both listener and request Host.
- Every response remains `no-store` with a least-privilege CSP.
- Exposing the Console through a tunnel or reverse proxy is unsupported.

The future hosted console is a separate browser client behind a same-origin
backend-for-frontend and ADR-004 sessions. It may reuse visual components and
read models, not the unauthenticated loopback trust boundary.

## 7. Performance budgets

- No unbounded ledger scan on a request or stream reconnect.
- Every list declares count/token/time bounds and an exclusive continuation.
- Overview is useful on an empty ledger and remains responsive on the largest
  certified fixture.
- Slow projections disclose partial/omitted sections rather than timing out
  ambiguously.
- Live updates coalesce invalidations; they do not resend the complete world
  for every event.

TQ-701 freezes the default/maximum page sizes at 50/100 records, fetches at
most `limit + 1`, accepts cursors up to 2,048 characters and certifies a
2,501-active-commitment fixture under a deliberately coarse 2,000 ms page plus
overview regression ceiling. See `TQ-701_CONSOLE_READ_MODELS.md`; the ceiling
is evidence guardrail, not a production latency SLO.

## 8. Delivery phases

| Phase | Scope | Gate |
|---|---|---|
| Existing baseline | TQ-504 read-first inspector | Already certified |
| TQ-701 | Canonical bounded overview/read models | Complete — empty, mature, hostile and large fixtures |
| TQ-702 | Cursor-driven SSE plus polling fallback | Restart, disconnect, gap, expiry and injected-clock tests |
| TQ-703 | Accessible responsive navigation, search and support bundle | Browser and accessibility certification |
| TQ-704 | Release/install integration, stable URLs and lifecycle | Clean-room local install/upgrade/uninstall |
| TQ-705 | Operator acceptance | Unknown operator resolves staged incidents without repository knowledge |

## 9. Acceptance scenarios

The Local Console is product-complete only when a fresh user can:

1. install Tasq Local and open the correct workspace from documented commands;
2. distinguish unclaimed, claimed, contended, waiting and terminal work;
3. find the current holder/fence and understand a crashed-attempt recovery;
4. inspect an effect from exact request through authority and verified outcome;
5. resume after server/browser restart without missing or duplicating meaning;
6. see stale/disconnected state without relying on raw device time;
7. diagnose a seeded health failure and produce a redacted support bundle;
8. do all of the above without a write route or privileged hidden endpoint.

## 10. Explicit non-claims

This specification does not claim that the complete Console exists, that Tasq
has remote browser access, that loopback is authentication, that a human can
approve effects in the current UI, or that the Console replaces machine APIs.
