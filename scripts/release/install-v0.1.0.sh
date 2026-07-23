#!/bin/sh
# Tasq Local v0.1.0 verified lifecycle bootstrap.
#
# Inspect first:
#   curl -fsSLo /tmp/tasq-install.sh https://tasq.run/install.sh
#   less /tmp/tasq-install.sh
#   sh /tmp/tasq-install.sh --dry-run
#
# Install:
#   sh /tmp/tasq-install.sh --version 0.1.0 --prefix "$HOME/.local"

set -eu

VERSION="0.1.0"
PREFIX="${HOME}/.local"
ACTION="install"
DRY_RUN="false"
REPOSITORY="https://github.com/gwendall/tasq"

usage() {
  cat <<'EOF'
Usage: install.sh [--version 0.1.0] [--prefix PATH] [--dry-run]
                  [--activate|--uninstall]

Installs only the certified macOS ARM64 or Linux x64 GNU release. The installer
does not edit shell startup files and never reads or removes TASQ_HOME.
EOF
}

fail() {
  printf '%s\n' "tasq installer: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --prefix)
      [ "$#" -ge 2 ] || fail "--prefix requires a value"
      PREFIX="$2"
      shift 2
      ;;
    --dry-run|--print-plan)
      DRY_RUN="true"
      shift
      ;;
    --activate)
      ACTION="activate"
      shift
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ "$VERSION" = "0.1.0" ] || fail "this versioned bootstrap supports only Tasq 0.1.0"
[ -n "$PREFIX" ] || fail "--prefix must not be empty"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    TARGET="darwin-arm64"
    CHECKSUMS_SHA256="35bc63bc9027511bcce5e87a68818eb6f7fde4151945ffcaf702df6aa090a2da"
    ;;
  Linux:x86_64)
    TARGET="linux-x64-gnu"
    CHECKSUMS_SHA256="a6d6c9cd1063b5e0c65c409af717e87cde9c623d083e769aff5e242c810b99b8"
    ;;
  *)
    fail "unsupported host: $(uname -s)-$(uname -m); supported: darwin-arm64, linux-x64-gnu"
    ;;
esac

ROOT="tasq-v${VERSION}-${TARGET}"
BASE="${REPOSITORY}/releases/download/v${VERSION}"
INSTALLER="${ROOT}.install.ts"
MANIFEST="${ROOT}.release.json"
CHECKSUMS="${ROOT}.SHA256SUMS"
ARCHIVE="${ROOT}.tar.gz"

if [ "$DRY_RUN" = "true" ]; then
  printf '%s\n' \
    "Tasq lifecycle plan" \
    "  action: ${ACTION}" \
    "  version: ${VERSION}" \
    "  target: ${TARGET}" \
    "  prefix: ${PREFIX}" \
    "  release: ${REPOSITORY}/releases/tag/v${VERSION}" \
    "  checksum-of-checksums: sha256:${CHECKSUMS_SHA256}" \
    "  data: TASQ_HOME is external and will not be touched"
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v bun >/dev/null 2>&1 || fail "Bun 1.3+ is required"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tasq-install.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT HUP INT TERM

download() {
  name="$1"
  curl --proto '=https' --tlsv1.2 -fLso "${TEMP_ROOT}/${name}" "${BASE}/${name}"
}

expected_digest() {
  name="$1"
  awk -v asset="$name" '$2 == asset { print $1 }' "${TEMP_ROOT}/${CHECKSUMS}"
}

verify_asset() {
  name="$1"
  expected="$(expected_digest "$name")"
  [ -n "$expected" ] || fail "checksum file does not name ${name}"
  actual="$(sha256_file "${TEMP_ROOT}/${name}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${name}"
}

download "$CHECKSUMS"
[ "$(sha256_file "${TEMP_ROOT}/${CHECKSUMS}")" = "$CHECKSUMS_SHA256" ] ||
  fail "release checksum manifest does not match the repository-pinned digest"
download "$INSTALLER"
verify_asset "$INSTALLER"

if [ "$ACTION" = "install" ]; then
  download "$MANIFEST"
  download "$ARCHIVE"
  verify_asset "$MANIFEST"
  verify_asset "$ARCHIVE"
  bun "${TEMP_ROOT}/${INSTALLER}" install \
    --prefix "$PREFIX" \
    --archive "${TEMP_ROOT}/${ARCHIVE}" \
    --manifest "${TEMP_ROOT}/${MANIFEST}" \
    --checksums "${TEMP_ROOT}/${CHECKSUMS}"
else
  bun "${TEMP_ROOT}/${INSTALLER}" "$ACTION" \
    --version "$VERSION" \
    --target "$TARGET" \
    --prefix "$PREFIX"
fi

printf '%s\n' \
  "Tasq ${VERSION} ${ACTION} complete." \
  "Executable: ${PREFIX}/bin/tasq" \
  "No shell startup file was changed. Add ${PREFIX}/bin to PATH explicitly if needed." \
  "TASQ_HOME and every ledger byte were left outside installer ownership."
