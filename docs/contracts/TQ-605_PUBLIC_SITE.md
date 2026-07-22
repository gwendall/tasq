# TQ-605 — Public product and documentation site

> **Status:** implemented, certified and deployed from public `main` — 2026-07-22
> **Deployment status:** live at <https://tasq-five.vercel.app>; custom domain pending
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
the advertised local CLI/MCP or future authenticated Server surface. Agents do
not parse the marketing HTML to coordinate work.

## 3. Truth pipeline

`apps/site/scripts/generate-truth.ts` validates and combines:

- `../concepts/PRODUCT_SURFACE_MATRIX.json` for shapes, surfaces, consumers and support;
- `../roadmap/BACKLOG.json` for execution status and external gates;
- `../releases/PUBLIC_RELEASE_POLICY.json` for identity, packages and distribution state.

It emits identical deterministic bytes to:

- `src/generated/product-truth.json` for the rendered application;
- `public/product-truth.json` for machine consumers.

Each output includes the SHA-256 digest and contract version of every source.
Build, typecheck and tests run the generator in `--check` mode and fail if a
contract changed without regenerating the snapshot. An unimplemented surface
cannot have an entrypoint. An unpublished release cannot render a distributed
product shape. Published installation copy is intentionally fail-closed: the
current tests require the source-build journey until the protected release
policy changes and a maintainer reviews the new instructions.

## 4. Information architecture

The static application provides:

- `/` — product thesis, failure model, kernel boundary and product shapes;
- `/docs/getting-started` — current source build and causal onboarding handoff;
- `/docs/agents` — safe loop, claims, revisions, cursors and untrusted prose;
- `/docs/mcp` — local stdio launch and host-owned capability closure;
- `/docs/humans` — CLI mutation and read-only Local Console inspection;
- `/docs/sdk` — integrator-owned store, identity and injected `Clock`;
- `/docs/operators` — local storage, backup, diagnosis and security boundary;
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
- exact support vocabulary coverage and no entrypoint for absent surfaces;
- unpublished-release and seven-package boundary assertions;
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
root directory. The production alias returns HTTP 200 with HTTPS at
<https://tasq-five.vercel.app>.

This deployment does not claim a custom domain, uptime, analytics, search
indexing or a published Tasq package. TQ-603 remains the authority for the
first protected package and artifact release. Connecting a custom domain is a
separate DNS operation and does not change the package support state.
