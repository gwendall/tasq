# TQ-810 — Stable remote schemas and Python client

> **Status:** source candidate complete; package publication gate open
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-810_REMOTE_SDK_CERTIFICATION.json`

The checked-in OpenAPI 3.1 contract freezes the bounded REST paths already
implemented by TQ-809: commitment reads, exclusive event reads, operation
discovery, idempotent operation execution and one-use enrollment redemption.

`clients/python` is a dependency-free Python 3.11+ client for that contract.
It validates endpoint, workspace, resource and request identities before I/O,
uses bearer credentials only in request headers, requires both idempotency key
and stable request ID for mutation, and maps transport/Server failures to a
typed error without inventing success.

The Python package does not import or reproduce Core, LibSQL, migrations,
authorization, conflict resolution or effect policy. The Server remains the
single authority and operation catalog.

The source candidate is not yet a PyPI support claim. Publication, provenance
and an exact downloaded-wheel test remain external release work.
