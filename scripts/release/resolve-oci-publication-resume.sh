#!/usr/bin/env bash
set -euo pipefail

if test "$#" != 3; then
  echo "usage: resolve-oci-publication-resume.sh <image> <version> <source-commit>" >&2
  exit 64
fi

image="$1"
version="$2"
source_commit="$3"

[[ "$image" =~ ^[a-z0-9./_-]+$ ]]
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]]

is_missing_manifest() {
  local reference="$1"
  local line
  local output
  output="$(cat)"
  while IFS= read -r line; do
    # GitHub's Linux runner can preserve buildx's terminal CR even though the
    # Actions log renderer hides it. Normalize only that line terminator so the
    # exact reference-bound miss remains fail-closed.
    line="${line%$'\r'}"
    if test "$line" = "ERROR: ${reference}: not found"; then
      return 0
    fi
  done <<< "$output"
  grep --extended-regexp --ignore-case --quiet \
    '(^|[^[:alnum:]_])(MANIFEST_UNKNOWN|manifest unknown)([^[:alnum:]_]|$)|HTTP[^[:digit:]]*404([^[:digit:]].*)?manifest|manifest([^[:digit:]].*)?HTTP[^[:digit:]]*404' \
    <<< "$output"
}

inspect_tag() {
  local reference="$1"
  local output
  local status
  local digest

  set +e
  output="$(docker buildx imagetools inspect "$reference" 2>&1)"
  status=$?
  set -e

  if test "$status" = 0; then
    digest="$(
      awk '$1 == "Digest:" { print $2 }' <<< "$output" |
        sort --unique
    )"
    if ! [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "Registry returned no unique immutable digest for $reference" >&2
      exit 1
    fi
    printf 'present:%s\n' "$digest"
    return
  fi

  if is_missing_manifest "$reference" <<< "$output"; then
    printf 'absent\n'
    return
  fi

  echo "Registry lookup failed without an explicit missing-manifest result: $reference" >&2
  printf '%s\n' "$output" >&2
  exit "$status"
}

version_result="$(inspect_tag "${image}:${version}")"
source_result="$(inspect_tag "${image}:sha-${source_commit}")"

version_digest=""
source_digest=""
if [[ "$version_result" == present:* ]]; then
  version_digest="${version_result#present:}"
fi
if [[ "$source_result" == present:* ]]; then
  source_digest="${source_result#present:}"
fi

if test -n "$version_digest" && test -n "$source_digest" &&
  test "$version_digest" != "$source_digest"; then
  echo "Existing version and source tags resolve to different immutable digests" >&2
  exit 1
fi

digest="${version_digest:-$source_digest}"
if test -n "$digest"; then
  jq --compact-output --null-input \
    --arg action reuse \
    --arg digest "$digest" \
    --argjson versionTagExists "$([[ -n "$version_digest" ]] && echo true || echo false)" \
    --argjson sourceTagExists "$([[ -n "$source_digest" ]] && echo true || echo false)" \
    '{
      action: $action,
      digest: $digest,
      versionTagExists: $versionTagExists,
      sourceTagExists: $sourceTagExists
    }'
else
  jq --compact-output --null-input \
    '{
      action: "build",
      digest: null,
      versionTagExists: false,
      sourceTagExists: false
    }'
fi
