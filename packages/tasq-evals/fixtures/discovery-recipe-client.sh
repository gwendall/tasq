#!/bin/sh
# Package-independent POSIX client. jq is its JSON parser; recipes remain argv.
set -eu

request=$(mktemp)
bootstrap=$(mktemp)
args=$(mktemp)
merged=$(mktemp)
cleanup() { rm -f "$request" "$bootstrap" "$args" "$merged"; }
trap cleanup EXIT HUP INT TERM
cat > "$request"

jq -r '.pointerArgv[]' "$request" > "$args"
set --
while IFS= read -r value; do set -- "$@" "$value"; done < "$args"
"$@" > "$bootstrap"

jq -e '
  .contractVersion == "tasq.autonomous-bootstrap.v1"
  and (.recipes | type == "array")
' "$bootstrap" >/dev/null

# Merge the discovered document into the request only for the jq recipe pass.
jq --slurpfile bootstrap "$bootstrap" '. + {bootstrap: $bootstrap[0]}' "$request" > "$merged"
jq -r '
  . as $root
  | ($root.actions[0].selector // null) as $selector
  | ($root.actions[0].replacements // {}) as $replacements
  | ([ $root.bootstrap.recipes[]
      | select(.version == 1)
      | select(
          if $selector == null then .id == $root.actions[0].recipeId
          else
            .outputContract == $selector.outputContract
            and .mutates == $selector.mutates
            and (($selector.requiredCapability // .requiredCapability) == .requiredCapability)
            and ((.parameters | map(.name) | sort) == (($selector.parameterNames // []) | sort))
          end
        )
    ]) as $matches
  | if ($matches | length) != 1 then error("recipe must exist exactly once at version 1") else $matches[0] end
  | . as $recipe
  | if (($recipe.parameters | map(.placeholder) | sort) != ($replacements | keys | sort))
    then error("recipe parameters differ from supplied replacements") else $recipe end
  | .argvTemplate[]
  | $replacements[.] // .
' "$merged" > "$args"
set --
while IFS= read -r value; do set -- "$@" "$value"; done < "$args"
"$@"
