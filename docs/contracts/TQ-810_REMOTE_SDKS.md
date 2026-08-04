# TQ-810 — Stable remote schemas and Python client

> **Status:** source candidate complete; package publication gate open
> **Date:** 2026-07-30
> **Machine certificate:** `TQ-810_REMOTE_SDK_CERTIFICATION.json`

The checked-in OpenAPI 3.1 contract freezes the bounded REST paths already
implemented by TQ-809: commitment reads, exclusive event reads, operation
discovery, idempotent operation execution and one-use enrollment redemption.

`clients/python` is a dependency-free Python 3.11+ client for that contract.
It validates endpoint, workspace, resource and request identities before I/O,
uses bearer credentials only in request headers, requires both idempotency key
and stable request ID for mutation, and maps transport/Server failures to a
typed error without inventing success. It also redeems an explicitly supplied
one-use enrollment token without accepting actor prose as identity.

The Python package does not import or reproduce Core, LibSQL, migrations,
authorization, conflict resolution or effect policy. The Server remains the
single authority and operation catalog.

The source candidate is not yet a PyPI support claim. Publication, provenance
and an exact downloaded-wheel test remain external release work.

`.github/workflows/publish-python.yml` and
`.github/workflows/certify-published-python.yml` now prepare that release path.
The builder creates one deterministic `py3-none-any` wheel, an empty-dependency
CycloneDX SBOM, exact checksums and source-bound metadata without reading the
device clock. Publication uses PyPI trusted publishing and provenance; replay
downloads the exact registry wheel, verifies its SHA-256 and GitHub
attestation, installs with `--no-deps` and reruns the client tests.

The publish workflow is deliberately resumable without PyPI's blind
`skip-existing` behavior. Every run rebuilds the deterministic protected
candidate first. An exact PyPI JSON 404 authorizes first publication; any
other lookup failure stops. If the version already exists, the canonical
wheel filename must be unique and not yanked, its declared SHA-256, downloaded
bytes and protected candidate bytes must all match exactly, and its GitHub
attestation must bind the `publish-python.yml` workflow, tagged source ref and
source commit. Only that proof permits the workflow to skip the already
completed upload and continue missing release metadata. Existing release
assets are likewise compared byte-for-byte after a successful asset listing;
network/auth errors and duplicate names never become absence.

The post-publication workflow now also requires an exact canonical Server
`sha256` digest. It pulls that digest, checks the Tasq OCI source, license,
version and source-revision labels, verifies the Server's protected-workflow
attestation, then starts the image with a read-only root, dropped capabilities,
an ephemeral volume and a loopback-only host port. A harness verifies that the
Tasq module is imported from the virtual environment where the downloaded
wheel was installed, then performs one-use enrollment and rejection of its
replay, an empty read, a real
`commitment.propose`, exact idempotent replay, a post-mutation read and a typed
invalid-credential failure. Its redacted JSON evidence is retained as the
workflow artifact `tasq-python-tq810-exact-artifact-evidence`.

The corresponding policy entry authorizes the exact `v0.4.0` public-alpha
coordinate. No wheel or Server image has been published and this protected
exact-artifact workflow has not run, so the
Python-against-exact-Server-digest external gate remains open.
Before tagging, configure the PyPI pending trusted publisher for project
`tasq-remote`, owner `gwendall`, repository `tasq`, workflow
`publish-python.yml` and GitHub environment `release`. Publication follows the
GitHub release and requires the exact protected Server digest; source or local
wheel evidence cannot substitute for either authority.
