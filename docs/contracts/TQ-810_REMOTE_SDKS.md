# TQ-810 — Stable remote schemas and Python client

> **Status:** `tasq-remote==0.4.0` published and exact-artifact certified
> **Date:** 2026-08-12
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

PyPI publication and provenance passed in protected run
[31518219329](https://github.com/gwendall/tasq/actions/runs/31518219329).
The canonical wheel SHA-256 is
`2e59bd0d3554cb94c2c1b086bff2760d53416142912c916e39bdb4bab99293c2`.

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

Protected run
[31619014178](https://github.com/gwendall/tasq/actions/runs/31619014178)
downloaded that exact wheel, verified its attestation and exercised it against
the immutable Server digest. TQ-810's public-alpha Python gate is complete;
source or local wheel evidence still cannot substitute for those authorities.
