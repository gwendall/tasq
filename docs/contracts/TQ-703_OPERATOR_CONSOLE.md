# TQ-703 — Local operator Console

## Outcome

`tasq web` now opens a complete local monitoring surface at `/`. It renders
canonical workspace state on the server, remains useful without JavaScript and
adds a small self-hosted client for bounded page filtering, TQ-702 live
invalidation and explicit support-bundle preview.

The previous commitment graph remains available at `/inspector`; stable detail
links remain `/commitments/{id}`. No mutation control or request exists in the
Console.

## Product and design contract

Design read: a developer-operations console for humans supervising independent
agents and runtimes. It is dense, calm and incident-first rather than a generic
task board.

- Design variance 4: predictable navigation and scan paths.
- Motion intensity 2: focus, hover and pressed feedback only.
- Visual density 7: compact operational data with whitespace between systems.
- System light/dark themes, one blue interaction accent and semantic
  green/amber/red states always paired with text.
- Native HTML, CSS and browser APIs only. There is no CDN, font request,
  framework runtime or checkout-relative asset.

## Information architecture

The persistent navigation exposes seven canonical TQ-701 projections:

1. active work;
2. actors;
3. task claims;
4. resource leases;
5. waits;
6. unresolved effects;
7. ordered audit timeline.

The top-level overview shows bounded attention signals and six operational
counts. Full integrity remains an explicit `tasq doctor --tenant <workspace>`
command. The UI never turns a nominal bounded-health response into a complete
integrity claim.

Every route is a deep link (`/?view=<section>&cursor=<opaque>`). Initial content
is server-rendered, including empty/error states. JavaScript filters only the
at-most-100 records already loaded; the result message says so and pagination
continues through the canonical cursor.

## Live behavior

The server captures a TQ-702 cursor with the HTML snapshot. The self-hosted
client reconnects SSE from that cursor and shows one of these textual states:

- Connecting;
- Live connection;
- Changes available;
- Catching up with polling;
- Disconnected. Retrying;
- History gap. Refresh required.

A change makes the visible page explicitly stale and offers “Refresh canonical
view”. It does not replay events into a hidden browser status machine. Overflow
uses the exact polling continuation to catch up before reconnecting SSE. Gap
recovery requires a fresh server snapshot. The client never reads device time.

## Support bundle

`GET /api/console/support-bundle` builds
`tasq.console-support-bundle.v1` from a single injected-time snapshot. It
contains overview, bounded health and at most 100 records from each section,
with explicit continuation cursors for every truncated section.

The artifact states that it omits:

- event payloads;
- provider bodies;
- effect requests;
- secret bindings;
- record metadata.

Titles, aliases, identifiers and other visible operator fields remain present,
so the human must review the exact JSON. The download link is hidden until a
successful local preview. The client creates the download from the exact JSON
string shown in that preview; no later server read and no hidden bundle cache
can change the reviewed bytes. The API refuses a direct `?download=1`
shortcut. This is a support snapshot, not a backup, full export or integrity
proof.

## Accessibility and responsive behavior

- semantic landmarks, sequential headings, tables, definition lists and an
  ordered audit list;
- first-focus skip link, persistent 3 px focus ring and logical DOM order;
- all controls and navigation targets at least 44 px high;
- color never acts as the sole state signal;
- 16 px mobile body text, wrapping identifiers and no body-level horizontal
  overflow;
- desktop sidebar becomes a two-column navigation on 390 px screens;
- data tables become labelled record grids on narrow screens;
- `prefers-color-scheme`, `prefers-reduced-motion` and
  `prefers-reduced-transparency` are honored.

## Security and authority

The listener and request Host remain loopback-only. Every response is
`no-store`; CSP permits scripts only from self and connections from self plus
the reviewed in-memory `blob:` download, with no inline or evaluated script.
Actor-provided strings are HTML-escaped server-side and support JSON is inserted
with `textContent`. All non-GET/HEAD methods remain denied.

SQLite and canonical services own all state and ordering. One injected `Clock`
snapshot drives each HTML, support or API response. The TQ-702 injected
`ConsoleScheduler` drives stream cadence only.

## Verification

- service tests cover hostile-data redaction, bundle completeness and a
  2,501-commitment truncated fixture;
- handler tests cover every asset/route, CSP, hostile escaping, typed support
  download and absence of device time in the client;
- six real Chromium journeys cover keyboard focus, bounded filtering, deep
  graph navigation, 390 px dark/reduced-motion layout, cross-process live
  invalidation, preview-before-download and browser-context mutation refusal;
- CI installs Chromium and runs the browser suite in addition to required
  Linux/macOS typecheck and full tests.

Installed-artifact startup, discovery and upgrade are certified by TQ-704.
Cross-platform empty, mature, hostile, corrupt and large-ledger browser
certification remains TQ-705.
