# TQ-902 — Same-origin Cloud BFF and authenticated Console

> **Status:** source candidate complete; deployed-browser gate open
> **Date:** 2026-07-24
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

A real public origin, identity provider integration, CSP deployment,
browser-automation matrix and external web security review remain external.
