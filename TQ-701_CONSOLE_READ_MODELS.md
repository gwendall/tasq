# TQ-701 — bounded Console read models

> **Status:** implemented and certified
> **Contracts:** `tasq.console-overview.v1`, `tasq.console-page.v1`,
> `tasq.console-health.v1`
> **Authority time:** injected `Clock` or explicit `now`, sampled once per read

## Outcome

Tasq now has one transport-neutral, profile-neutral operator read layer over the
canonical ledger. It is exported by `@tasq/core`, consumed by the loopback
`@tasq/console` server, and contains no Console-owned state. A future UI, MCP
tool or authenticated server can render the same contracts without rebuilding
coordination meaning.

The pre-existing TQ-504 inspector remains canonical for commitment search and
complete `tasq.inspect.v1` graph detail. TQ-701 adds only the missing
workspace-level views:

| View | Existing before TQ-701 | TQ-701 result |
|---|---|---|
| Work | Bounded search/index and full commitment detail | Stable active-work keyset page |
| Actors | Only reachable through graph detail | Redacted actor page |
| Claims/resources | Only graph or resource-specific reads | Current held coordination pages with injected-time status |
| Waits/effects | Only graph detail | Bounded unresolved attention pages |
| Audit | Task detail and event service | Workspace event page with exclusive cursor and omitted payload |
| Health | Full, unbounded explicit `doctor` | Cheap bounded signals that never claim full integrity |

## HTTP routes

The existing loopback-only, read-only handler exposes:

- `GET|HEAD /api/console/overview`;
- `GET|HEAD /api/console/health`;
- `GET|HEAD /api/console/{work|actors|claims|resources|waits|effects|audit}`
  with `limit=1..100` and an optional opaque `cursor`.

All routes inherit Host validation, DNS-rebinding refusal, `no-store`, the
script-free CSP, method denial and the injected HTTP `Date` header. There is no
write route, credential-bearing query parameter or hidden listener.

## Cursor and consistency contract

- Cursors are exclusive, opaque, versioned and bound to the exact workspace
  and section. Cross-workspace or cross-section reuse fails closed.
- Mutable lists order by immutable creation/acquisition keys plus record ID;
  audit orders by immutable sequence. Updates cannot silently move an already
  seen row across the continuation boundary.
- Each query asks SQLite for at most `limit + 1` rows. The extra row discloses
  `hasMore`; it is never returned to the caller.
- Migration `0025_console_read_indexes.sql` gives every mutable page a partial
  or scoped keyset index; the large-fixture test requires `idx_console_work`
  and rejects a temporary sort in SQLite's query plan.
- Current-state filters are truthful at each page read. A record that becomes
  terminal or released between pages may leave the current view; this API does
  not pretend to provide historical snapshot isolation. Audit is the durable
  reconstruction surface.

## Redaction and authority

Page records whitelist operator-safe identity and lifecycle fields. They omit
principal metadata, claim/resource metadata, wait parameters, exact effect
requests and secret bindings, provider bodies, event payloads and delivery
errors. Audit items carry the explicit marker
`{ omitted: true, reason: "operator_index_redaction" }`.

Expiry and overdue decisions compare persisted values only with the one
injected `inspectedAt`. Neither the read layer nor the HTTP handler reads the
device clock. The health model reports `scope: bounded_operational_signals`.
It explicitly says full integrity was not checked and returns a structured
`["tasq", "doctor", "--tenant", workspaceId]` argv recipe rather than a
shell-interpolated command.

## Frozen budgets

| Boundary | Budget |
|---|---|
| Default / maximum page size | 50 / 100 records |
| Rows fetched per page query | at most `limit + 1` |
| Opaque cursor input | at most 2,048 characters |
| Overview | 10 indexed count/existence queries; no record-body materialization |
| Health | 12 bounded/count/cursor queries; full doctor excluded |
| Certified large fixture | 2,501 active commitments |
| Coarse regression ceiling | page + overview under 2,000 ms |

The ceiling is a deliberately generous CI regression guard, not a production
latency SLO. The certification fixture passes on both the service test and the
repository CI matrix; larger product claims require new evidence.

## Evidence

- `packages/tasq-service/test/console-read-models.test.ts`: empty/missing,
  mature, hostile, cross-scope cursor, injected-time and 2,500-record cases;
- `packages/tasq-inspector/test/inspector.test.ts`: real loopback route,
  redaction, HEAD, Host/security and malformed-input cases;
- `packages/tasq-evals/console-read-contract.test.ts`: public export, docs,
  route completeness, bounds and ambient-clock prohibition.

TQ-701 does not itself claim live updates, the complete visual Console,
support bundles, installed-artifact startup or browser operator acceptance.
Live transport is TQ-702 and the operator UI is TQ-703; installed lifecycle and
cross-platform browser acceptance remain TQ-704 and TQ-705.
