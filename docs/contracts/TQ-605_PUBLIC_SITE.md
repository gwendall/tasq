# TQ-605 — Public product and documentation site

> **Status:** implemented, certified and deployed from public `main` — 2026-07-23
> **Deployment status:** live at <https://tasq.run>
> **Authority:** `../concepts/PRODUCT_SURFACE_MATRIX.json`, `../roadmap/BACKLOG.json` and
> `../releases/PUBLIC_RELEASE_POLICY.json`, never hand-authored website state

## 1. Outcome

Tasq now has a distinct public product and documentation application candidate in
`apps/site`. It is a Next.js App Router application written in TypeScript,
styled with Tailwind CSS and repository-owned shadcn/ui components. Its
production output is static HTML, CSS, JavaScript and JSON.

The application explains the product, routes each current consumer to a
supported entrypoint, shows unsupported surfaces without euphemism and exposes
the same machine truth at `/product-truth.json`. It has no ledger, API route,
Console import, provider integration, authentication boundary or runtime
listener of its own.

## 2. First-principles boundary

The public site has three jobs:

1. let an unfamiliar person understand why Tasq exists;
2. give each human or agent consumer the shortest honest path into the product;
3. prevent marketing presentation from becoming a second product truth.

It is not the Local Console. The Console reads one live local ledger and is
loopback-only. The public site reads versioned repository contracts at build
time and is safe to serve as static public content. It cannot inspect or mutate
a Tasq workspace.

It is also not an agent API. A machine can read `/product-truth.json`, then use
the advertised Local CLI/MCP or authenticated self-hosted Server surface.
Agents do not parse the marketing HTML to coordinate work.

## 3. Truth pipeline

`apps/site/scripts/generate-truth.ts` validates and combines:

- `../concepts/PRODUCT_SURFACE_MATRIX.json` for shapes, surfaces, consumers and support;
- `../roadmap/BACKLOG.json` for execution status and external gates;
- `../releases/PUBLIC_RELEASE_POLICY.json` for identity, packages and distribution state;
- `../site/PUBLIC_SITE_DOCS.json` for public documentation prose, navigation and
  references to executable code examples.

It emits identical deterministic bytes to:

- `src/generated/product-truth.json` for the rendered application;
- `public/product-truth.json` for machine consumers;
- `src/generated/docs.json` for the rendered documentation application.

Each output includes the SHA-256 digest and contract version of every source.
Build, typecheck and tests run the generator in `--check` mode and fail if a
contract changed without regenerating the snapshot. Documentation prose does
not live in the TypeScript rendering adapter. That adapter resolves named code
examples from the executable example registry, so prose has one source while
commands retain their independent execution tests. An unimplemented surface
cannot have an entrypoint. An unpublished release cannot render a distributed
product shape.

## 4. Information architecture

The static application provides:

- `/` — product thesis, failure model, kernel boundary and product shapes;
- `/docs/getting-started` — current source build and causal onboarding handoff;
- `/docs/agents` — safe loop, claims, revisions, cursors and untrusted prose;
- `/docs/mcp` — Local stdio launch, host-owned capability closure and the
  distinct authenticated Server transport;
- `/docs/humans` — CLI mutation and read-only Local Console inspection;
- `/docs/sdk` — integrator-owned store, identity and injected `Clock`;
- `/docs/operators` — Local storage, backup and diagnosis plus the explicit
  self-hosted Server operator boundary;
- `/docs/architecture` — commitment/claim/attempt/evidence separation;
- `/docs/support` — exact current product and publication non-claims;
- `/status` — generated release gates, surfaces and source-contract digests;
- `/product-truth.json` — the exact versioned machine-readable snapshot.

Copy is deliberately clear before clever: there are no invented metrics,
customers, testimonials or availability claims. The only product-state
illustration is visibly marked synthetic.

## 5. Clock, privacy and security

The site makes no authority-time decision and reads no ambient clock. The
truth snapshot displays the versioned `updatedAt` from its source contract.
Source scans reject `Date.now`, `new Date` and `performance.now` in application
and generation code.

The app contains only synthetic diagrams and versioned product facts. It has
no user ledger, secret, credential, form submission, analytics SDK or server
action. Static export creates no listener; hosting is an independent later
deployment decision.

## 6. Executable evidence

The checkpoint requires:

- deterministic truth generation and stale-output refusal;
- deterministic documentation generation bound to the source prose digest;
- no documentation prose duplicated in the TypeScript rendering adapter;
- exact support vocabulary coverage and no entrypoint for absent surfaces;
- protected-release, eight-package, Server and managed-Cloud boundary assertions;
- all eight consumer learning paths;
- source scans for ambient clocks, fake install/remote claims and Console/Core
  runtime coupling;
- identical browser and internal JSON truth;
- optimized static export of all routes;
- Chromium journeys over homepage, docs, status JSON and a 390px viewport;
- repository-wide typecheck, tests and Linux/macOS CI.

Run the focused gate with:

```bash
pnpm --filter @tasq-internal/site typecheck
pnpm --filter @tasq-internal/site test
pnpm --filter @tasq-internal/site test:browser
```

## 7. Honest remaining boundary

TQ-605 certifies the versioned application in the public source repository. On
2026-07-22 the `kamirobotics/tasq` Vercel project was connected directly to
`gwendall/tasq`, with `main` as its production branch and `apps/site` as its
root directory. The canonical domain returns HTTP 200 with HTTPS at
<https://tasq.run>.

This static-site deployment does not itself provide an uptime SLA, analytics,
remote coordination or managed Cloud. Protected releases separately publish
Tasq Local, remote clients and the self-hosted Server image; the custom domain
does not change those package or service support states.
