# TQ-604 clean-room lifecycle certification

**Status:** candidate lifecycle implemented and certified in source CI;
published `v0.1.0` exact-byte replay ready on both targets
**Machine contract:** `TQ-604_LIFECYCLE_CERTIFICATION.json`

## What now exists

Every target release contains a standalone Bun lifecycle tool beside its
archive, SBOM, manifest and checksum file. It installs Tasq into an explicit
prefix without a repository checkout:

```text
<prefix>/bin/tasq
<prefix>/lib/tasq/<version>/<target>/...
<prefix>/share/tasq/installations/<version>-<target>.json
```

Versions live side by side. `activate` atomically changes only the managed
`<prefix>/bin/tasq` symlink. It refuses to replace a regular file or an
unmanaged path. `uninstall` removes only the selected binary and its install
record. It never reads, moves or deletes `TASQ_HOME`.

The installer verifies its own digest, the manifest digest and the archive
digest against `SHA256SUMS`; it also binds archive identity to the version,
source commit and current native target declared by the manifest. It rejects
unsafe tar paths and symlinks in an extracted payload. The checksum file is
not a signature: consumers must additionally verify the protected GitHub
artifact attestation before running the installer.

## Supported commands

Given the five files for one version and target:

```bash
bun tasq-v0.1.0-darwin-arm64.install.ts install \
  --archive tasq-v0.1.0-darwin-arm64.tar.gz \
  --manifest tasq-v0.1.0-darwin-arm64.release.json \
  --checksums tasq-v0.1.0-darwin-arm64.SHA256SUMS \
  --prefix "$HOME/.local"

bun tasq-v0.1.0-darwin-arm64.install.ts activate \
  --version 0.1.0 --target darwin-arm64 --prefix "$HOME/.local"

bun tasq-v0.1.0-darwin-arm64.install.ts uninstall \
  --version 0.1.0 --target darwin-arm64 --prefix "$HOME/.local"
```

Version `0.1.0` is published at the immutable GitHub release. Linux uses target
`linux-x64-gnu`.

## Upgrade and rollback

Upgrade means:

1. create and retain a verified `tasq backup` snapshot;
2. install the new release beside the old release;
3. let `install` atomically activate the new binary;
4. run `tasq doctor --tenant <workspace> --actor <actor> --json` and inspect
   the ledger;
5. keep the prior binary and snapshot through the observation window.

Tasq does not promise in-place database downgrade. Rollback means restoring a
snapshot created for the old version into an isolated or stopped data home,
then activating the matching old binary. A binary switch alone is not a data
rollback.

## Executable evidence

`packages/tasq-cli/test/public-lifecycle.test.ts` starts with only generated
release assets in a hostile temporary directory. It verifies the envelope,
installs v1, onboards two independent actors, races them for one resource,
releases and reacquires with a higher fence, and opens the loopback Console on
the same workspace. TQ-704 extends that step through the installed UI assets,
versioned listener announcement, proof-of-life discovery, clean stop and a
second same-ledger Console after v2 activation. It then backs up, installs v2, runs `doctor`, restores the
snapshot with v1, and uninstalls both versions while proving both data homes
remain present. Separate cases refuse tampering and unmanaged collisions.

The suite runs on the required macOS arm64 and Linux x64 CI jobs. Release
construction and lifecycle inputs contain no wall-clock field, and the
installer contains no device-clock read. Runtime authority time remains behind
the explicit injected `Clock` boundary.

## Honest completion boundary

This closes the implementation and candidate-certification part of TQ-604.
The protected workflow has published the first artifacts. TQ-604 becomes
complete after their GitHub attestations are verified and this same journey
succeeds from those downloaded bytes on both targets. npm scope control and
trusted publishing are completed TQ-603 evidence.
