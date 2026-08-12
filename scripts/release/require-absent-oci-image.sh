#!/usr/bin/env bash
set -euo pipefail

if test "$#" -lt 1; then
  echo "usage: require-absent-oci-image.sh <image-reference>..." >&2
  exit 64
fi

for reference in "$@"; do
  exact_reference_miss=false
  set +e
  output="$(docker buildx imagetools inspect "$reference" 2>&1)"
  status=$?
  set -e

  if test "$status" = 0; then
    echo "Refusing to overwrite existing image tag: $reference" >&2
    exit 1
  fi

  # A registry miss is safe only when the registry explicitly identifies the
  # missing object as a manifest, or buildx binds "not found" to the exact
  # requested reference. Generic "not found" output remains ambiguous.
  while IFS= read -r line; do
    line="${line%$'\r'}"
    if test "$line" = "ERROR: ${reference}: not found"; then
      exact_reference_miss=true
      break
    fi
  done <<< "$output"
  if test "$exact_reference_miss" = true ||
    printf '%s\n' "$output" |
    grep --extended-regexp --ignore-case --quiet \
      '(^|[^[:alnum:]_])(MANIFEST_UNKNOWN|manifest unknown)([^[:alnum:]_]|$)|HTTP[^[:digit:]]*404([^[:digit:]].*)?manifest|manifest([^[:digit:]].*)?HTTP[^[:digit:]]*404'; then
    continue
  fi

  echo "Registry lookup failed without an explicit missing-manifest result" >&2
  printf '%s\n' "$output" >&2
  exit "$status"
done
