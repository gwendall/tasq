# TQ-902 — Same-origin Cloud BFF and authenticated Console

> **Status:** hardened reference browser matrix passed; real-identity and independent gates open
> **Date:** 2026-08-20
> **Machine certificate:** `TQ-902_CLOUD_BFF_CERTIFICATION.json`

The Cloud BFF accepts only requests whose URL matches its canonical HTTPS
public origin. It resolves an HttpOnly `__Host-` session inside the control
plane, checks tenant membership, and obtains a short-lived Server credential
through a host callback. The browser never receives that credential.

Mutations require both an exact `Origin` and a session-bound CSRF token.
Cookies, origin and CSRF headers are removed before proxying; downstream
`Set-Cookie` is removed from the response; redirects are manual and responses
are private/no-store. A session from tenant A cannot use a workspace route for
tenant B. Missing CSRF, foreign origin, revoked device, recovered principal,
expired session and suspended tenant fail closed.

Every `/effects` path is denied unconditionally. The BFF can carry the
authenticated read-only hosted Console and guarded non-effect Server
operations, but it is not an alternate authority layer.

The experimental origins first passed Chromium, Firefox and WebKit session,
BFF, remote-effect-denial and logout checks on 2026-08-13. Review then found
that the reference identity runtime minted authorization codes without first
authenticating an operator. Current source corrects that boundary with an
explicit HTTP Basic gate, exact proxy/redirect coordinates, bounded issuer
clock skew and one-use expiring codes, backed by adversarial tests.

Protected workflow run
[`32406910459`](https://github.com/gwendall/tasq/actions/runs/32406910459)
deployed that current source on 2026-08-20. Anonymous authorization returned
401, authenticated authorization returned 303, and Chromium, Firefox and
WebKit passed callback, hardened session-cookie, BFF read, unconditional
remote-effect denial and logout checks. The exact checked-in records are
`../../evidence/managed-cloud-deployment-2026-08-20.json` and
`../../evidence/managed-cloud-browser-2026-08-20.json`.

A real identity provider and external web security review remain external;
the Basic-gated reference runtime is a bounded private-beta adapter, not a
substitute for either gate.
Their evidence slots and independent-review requirement are frozen by the
[`managed Cloud production-readiness schema`](MANAGED_CLOUD_PRODUCTION_READINESS.schema.json);
the checked-in template remains intentionally incomplete.
