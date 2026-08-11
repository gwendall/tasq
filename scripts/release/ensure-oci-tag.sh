#!/usr/bin/env bash
set -euo pipefail

if test "$#" != 3; then
  echo "usage: ensure-oci-tag.sh <tag-reference> <digest-reference> <expected-digest>" >&2
  exit 64
fi

tag_reference="$1"
digest_reference="$2"
expected_digest="$3"

[[ "$tag_reference" =~ ^[a-z0-9./_-]+:[A-Za-z0-9._-]+$ ]]
[[ "$digest_reference" =~ ^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$ ]]
[[ "$expected_digest" =~ ^sha256:[a-f0-9]{64}$ ]]
test "${digest_reference##*@}" = "$expected_digest"

is_missing_manifest() {
  local reference="$1"
  local output
  output="$(cat)"
  if grep --fixed-strings --line-regexp --quiet \
    "ERROR: ${reference}: not found" <<< "$output"; then
    return 0
  fi
  grep --extended-regexp --ignore-case --quiet \
    '(^|[^[:alnum:]_])(MANIFEST_UNKNOWN|manifest unknown)([^[:alnum:]_]|$)|HTTP[^[:digit:]]*404([^[:digit:]].*)?manifest|manifest([^[:digit:]].*)?HTTP[^[:digit:]]*404' \
    <<< "$output"
}

resolve_tag() {
  local output
  local status
  local digest

  set +e
  output="$(docker buildx imagetools inspect "$tag_reference" 2>&1)"
  status=$?
  set -e

  if test "$status" = 0; then
    digest="$(
      awk '$1 == "Digest:" { print $2 }' <<< "$output" |
        sort --unique
    )"
    if ! [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "Registry returned no unique immutable digest for $tag_reference" >&2
      exit 1
    fi
    printf 'present:%s\n' "$digest"
    return
  fi

  if is_missing_manifest "$tag_reference" <<< "$output"; then
    printf 'absent\n'
    return
  fi

  echo "Registry lookup failed without an explicit missing-manifest result: $tag_reference" >&2
  printf '%s\n' "$output" >&2
  exit "$status"
}

result="$(resolve_tag)"
if [[ "$result" == present:* ]]; then
  actual="${result#present:}"
  if test "$actual" != "$expected_digest"; then
    echo "Refusing to overwrite $tag_reference: expected $expected_digest, found $actual" >&2
    exit 1
  fi
  printf 'verified-existing %s %s\n' "$tag_reference" "$expected_digest"
  exit 0
fi

docker buildx imagetools create \
  --tag "$tag_reference" \
  "$digest_reference"

result="$(resolve_tag)"
if ! [[ "$result" == present:* ]] ||
  test "${result#present:}" != "$expected_digest"; then
  echo "Published tag did not resolve to the expected digest: $tag_reference" >&2
  exit 1
fi
printf 'published-and-verified %s %s\n' "$tag_reference" "$expected_digest"
