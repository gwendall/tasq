# TQ-634 — Directory-scoped space selection

Status: source candidate complete; exact `v0.4.0` publication remains.

## Problem and primitive

One Tasq home intentionally contains several coordination spaces. Requiring
`--tenant` on every command is repetitive, while `tasq setup` changes the
operator's global human defaults. The missing primitive is a private local
context binding, not another workspace record and not repository state.

`tasq use <space>` binds the canonical real path of the current directory to a
schema-valid space in private `~/.tasq/config.json`. Descendants inherit the
closest ancestor binding. `tasq use` reports the effective selection and its
source; `tasq use --clear` removes only the exact current-directory binding.

Selection precedence is exact:

1. explicit `--tenant`;
2. non-empty `TASQ_TENANT`;
3. closest canonical directory binding;
4. configured global default.

## Safety and non-claims

- The command never changes `tenantId` or `defaultActor`.
- It writes no repository file, opens no ledger and does not assert that a
  syntactically valid space already exists.
- Canonical real paths collapse symlink aliases; stored paths and spaces are
  bounded and validated on config load.
- Directory selection is local convenience, not authentication, permission or
  effect authority.

## Evidence

- `packages/tasq-cli/src/config.ts`
- `packages/tasq-cli/src/commands/use.ts`
- `packages/tasq-cli/test/local-workflow.test.ts`
- `docs/contracts/TQ-634_DIRECTORY_SPACE_SELECTION.json`
