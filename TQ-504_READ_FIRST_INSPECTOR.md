# TQ-504 - Read-first local inspector

> **Status:** implemented and accepted 2026-07-20
> **Surface:** local loopback HTTP, server-rendered HTML and existing canonical JSON
> **Authority:** none; every non-GET request fails closed

## 1. Problem demonstrated by the existing surface

The machine path is already correct. An unfamiliar agent can use a bounded
`tasq.context-packet.v1`, then drill into one complete `tasq.inspect.v1`
snapshot through CLI or MCP. A web UI must not replace that contract or become
a new agent onboarding dependency.

The human audit path is materially weaker. The profile-neutral Markdown
renderer shows counts for effects, approvals and receipts, but not the records
needed to audit their chain. The JSON snapshot contains more than twenty
top-level collections. A person must manually correlate condition,
observation, reconciliation, effect, approval, receipt, principal and event
identities. That is the proven friction TQ-504 addresses.

## 2. First-principles boundary

The inspector is a projection, not a product kernel:

- LibSQL remains the only source of truth.
- `@tasq-internal/local-service` remains the only domain read/write implementation.
- `tasq.inspect.v1` remains the complete commitment graph.
- the inspector owns no table, migration, status, policy or provider schema;
- it exposes no mutation route, button, form or client-side write code;
- it never grants effect authority, principal authentication or remote access;
- all snapshot time comes from an injected `Clock`;
- actor-authored strings are escaped and rendered as data;
- the default and only implemented listener boundary until an ADR-004 hosted
  adapter passes its acceptance gate is loopback.

ADR-004/TQ-505, not this surface, owns the accepted design for authenticated
remote principals, multi-user tenancy, TLS termination and hosted transport;
none of those remote components is implemented yet.

## 3. Architecture

`@tasq/console` is a sibling surface beside CLI and MCP. It contains:

1. a bounded index read model composed by the service layer;
2. a Fetch-compatible request handler;
3. deterministic server-rendered HTML and a self-contained stylesheet;
4. a Bun loopback composition helper used by `tasq web`.

```text
browser GET/HEAD
      |
      v
@tasq/console  -->  @tasq/core  -->  LibSQL
      |
      +-- HTML projection
      +-- tasq.inspector-index.v1
      +-- tasq.inspect.v1 (unchanged)
```

The handler is separately testable from its Bun listener. Another local host
can mount the Fetch handler without importing CLI configuration. No React,
hydration, remote font, CDN or runtime asset lookup is required.

## 4. Routes and contracts

| Route | Result |
|---|---|
| `GET /` | bounded commitment index with status/search filters and aggregate wait/effect/authority counts |
| `GET /commitments/:id` | human audit view over one exact `tasq.inspect.v1` snapshot |
| `GET /api/index` | `tasq.inspector-index.v1` |
| `GET /api/commitments/:id` | existing `tasq.inspect.v1` |
| `GET /assets/inspector.css` | immutable self-contained visual tokens/styles |

`HEAD` has the same status and headers without a body. Every other method
returns `405` with `Allow: GET, HEAD`. Unknown routes return `404`; foreign or
missing commitment IDs do not leak another workspace.

The index is hard-bounded to 100 commitments. It reports the exact applied
filter, total candidates considered inside that bound and visible truncation.
It includes only coordination signals needed to choose a graph to inspect,
not raw effect requests, evidence bodies or metadata.

## 5. Security contract

Every response is `no-store` and sends a strict CSP with no script permission,
no external origin, no framing, no base override and same-origin forms only.
The surface also sends `nosniff`, no-referrer and same-origin resource policy.

HTML uses one escaping function for every actor-controlled value. JSON is
serialized by the runtime and never interpolated into executable markup.
Search is a bounded read filter. There is no JavaScript bundle and no hidden
POST/fetch path.

The listener rejects `0.0.0.0`, LAN addresses and public hostnames. Binding
loopback is a deployment invariant, not a safe default that callers can
silently override.

## 6. Interface direction

This is a dense technical inspector, not a marketing dashboard. It uses
semantic HTML, system fonts, one blue focus/link accent, functional status
colors, restrained 8px radii and no automatic motion. Light and dark tokens
follow the system preference. Tables scroll horizontally on narrow screens;
the index collapses to one column and detail navigation stays keyboard-first.

The commitment page makes four relationships visible without inventing
causality:

- waits -> observations -> reconciliations;
- effects -> approval history -> receipts;
- claims -> attempts -> evidence -> completion records;
- ordered audit events and resume watermarks.

IDs, digests, versions and timestamps remain copyable text. Raw structured
payloads are collapsed in accessible `<details>` blocks rather than promoted
to primary prose.

## 7. CLI composition

```bash
tasq web --tenant robotics/team-a --host 127.0.0.1 --port 4137
```

`--tenant` is mandatory. Host defaults to `127.0.0.1`; only loopback aliases
are accepted. Port `0` asks the OS for an isolated test port. The startup line
states the exact bound URL and that the surface is unauthenticated local read
access. The process closes the HTTP listener before closing the database.

## 8. Acceptance gate

- one index request locates commitments and exposes wait/effect/authority
  signal counts without N+1 client commands;
- one detail request displays individual wait, reconciliation, effect,
  approval, receipt and audit identities from the canonical snapshot;
- POST/PUT/PATCH/DELETE cannot mutate and leave the database unchanged;
- script-like titles, actor labels, summaries and payloads remain inert text;
- CSP and security headers are present on success and error responses;
- empty, filtered-empty, not-found and internal-error states are readable;
- index limits, search length, status values, path decoding and methods fail
  closed;
- a forbidden device clock proves every read uses the injected clock;
- non-loopback bind attempts fail before opening a listener;
- package-boundary tests prove the surface depends inward on the kernel and
  the kernel never imports the inspector;
- browser tests verify desktop, narrow viewport, keyboard focus, light/dark
  rendering and absence of mutation controls;
- the complete Tasq suite and release-artifact onboarding certification remain
  green.

TQ-504 is done only when this surface reduces human audit friction while
leaving machine onboarding, domain semantics and authority exactly where they
were.

## 9. Implemented evidence and findings

The shipped `@tasq/console` package owns only a bounded service read
model, pure HTML/CSS rendering, a Fetch-compatible handler and the Bun
loopback listener. `tasq web` imports it lazily, requires an explicit tenant,
announces the exact URL and unauthenticated-local boundary, handles
`SIGINT`/`SIGTERM`, then closes the listener before the database.

Implementation found two boundaries worth making explicit:

1. loopback binding alone did not stop DNS rebinding, so the handler also
   rejects every Host-derived request URL whose hostname is not
   `127.0.0.1`, `::1` or `localhost`;
2. Bun would add a device-clock `Date` header even though domain snapshots used
   an injected clock, so each request now captures one injected timestamp and
   uses it for both the canonical read and the HTTP header, including failures.

Executable evidence covers the bounded constant-query index, literal wildcard
search, signal aggregates, missing-clock refusal, workspace isolation, XSS,
all mutation methods, malformed paths/filters, security headers, internal
errors, loopback/ephemeral ports, CLI shutdown/reopen and package direction.
Four Chromium journeys additionally cover desktop, keyboard focus, filtering,
detail navigation, 390px dark/reduced-motion layout and browser-context method
refusal. The release artifact is exercised through the CLI build/smoke gate.

This surface is deliberately absent from autonomous onboarding recipes. Agents
already have smaller JSON/CLI/MCP reads; the inspector is a human audit
projection, not a new machine dependency or remote administration surface.
