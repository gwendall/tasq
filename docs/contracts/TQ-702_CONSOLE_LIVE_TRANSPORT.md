# TQ-702 — Console live transport

## Outcome

Tasq Local exposes one bounded, lossless change-feed contract through polling
and loopback server-sent events (SSE). The feed is not a second source of truth:
it contains redacted immutable event identities and tells a client when to
re-read the canonical TQ-701 projections.

The public contracts are:

- `tasq.console-event-batch.v1`;
- `tasq.console-stream-envelope.v1`;
- `tasq.console-live-problem.v1`.

## Routes

| Route | Result |
|---|---|
| `GET /api/console/events` | initial overview snapshot and exclusive event cursor |
| `GET /api/console/events?cursor=…&limit=…` | ascending events strictly after the cursor |
| `GET /api/console/stream` | SSE snapshot followed by bounded change batches |
| `GET /api/console/stream?cursor=…` | SSE reconnect after an accepted cursor |

SSE also accepts the standard `Last-Event-ID` header. Supplying a different
query cursor and header is a `400` request error. `HEAD` returns the same
headers and no stream body.

## Cursor and recovery semantics

The opaque cursor is versioned and workspace-bound. It contains the last
accepted durable SQLite event sequence; reads are exclusive (`sequence >
cursor`). An initial request captures the event high-water mark before building
the overview. A concurrent mutation can therefore be reflected both in that
overview and in the next invalidation, but can never be missed between them.

- A cursor ahead of the current ledger returns `409 cursor_ahead`. This catches
  an old database restored underneath a newer client.
- A non-zero cursor below the retained workspace floor returns `409
  cursor_expired`.
- Both problems require a fresh snapshot from `/api/console/events`; neither
  silently resets or substitutes timestamp polling.
- A reconnect starts from the last SSE `id` only after the consumer has
  accepted that complete frame.

## Backpressure and overflow

Every database read fetches at most `limit + 1` rows. The default page is 50
events and the maximum is 100. The `ReadableStream` high-water mark is one, so
the server does not query or enqueue the next batch until the consumer accepts
the current chunk.

If more events are pending than fit in one SSE batch, the frame is typed
`overflow`, includes the first bounded batch, and closes the stream. After
processing those events, the client uses the returned exact cursor with the
polling route until `hasMore` becomes false, then reconnects SSE. No in-memory
overflow buffer and no lossy shortcut exist.

An idle connection receives only an SSE comment. The comment asserts no
freshness and carries no timestamp.

## Authority and time

SQLite remains the only state and ordering authority. SSE event payloads are
always `{ omitted: true, reason: "operator_stream_redaction" }`; provider
bodies, effect requests, metadata and secrets are absent.

Each poll or stream batch samples the injected `Clock` once. The server never
consults the device clock for expiry, ordering, cursor validity or freshness.
Transport cadence uses an independently injected `ConsoleScheduler`; its sole
production adapter uses a host timer only to wake the next bounded read and
cannot supply domain time.

## Client algorithm

1. Fetch the no-cursor polling route and render its canonical overview.
2. Persist its `nextCursor` only after accepting the whole response.
3. Connect SSE with that cursor (or `Last-Event-ID`).
4. For each event identity, invalidate and re-read the relevant canonical
   TQ-701 projection; do not replay an independent status machine.
5. On `overflow`, process the included batch, poll from its recovery cursor to
   exhaustion, then reconnect.
6. On `gap`, `cursor_expired` or `cursor_ahead`, discard derived presentation
   state and fetch a fresh snapshot.
7. Show disconnected/stale presentation explicitly; browser time may animate
   it but may not decide correctness.

## Frozen bounds

| Boundary | Limit |
|---|---:|
| default / maximum events per read | 50 / 100 |
| rows fetched per change query | `limit + 1` |
| opaque cursor input | 2,048 characters |
| queued SSE frames per connection | 1 |
| production poll cadence | 1,000 ms |
| configurable cadence range | 1–60,000 ms |

## Verification

The service suite covers initial capture, a mutation at the snapshot boundary,
exclusive monotone paging, hostile-body redaction, workspace binding, overflow,
ahead-ledger recovery and pruned-cursor recovery. Inspector tests exercise
polling, SSE, `Last-Event-ID`, backpressure, overflow-to-poll continuation,
typed `409`, `HEAD`, security headers and injected time/scheduling. The public
eval imports the live reader only through `@tasq-run/core`, checks the Core/service
mirror and rejects ambient clocks in both implementations.

This checkpoint supplies transport contracts. TQ-703 now consumes them in the
accessible operator UI with filters, timelines, disconnected states and
support bundles.
