## Outcome

Describe the observable result, not only the files changed.

## Owning contracts

- Backlog/ADR/TQ:
- Human and machine truth updated together:

## Verification

- [ ] `pnpm docs:check`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Relevant browser or clean-room suite, when applicable
- [ ] `git diff --check`

## Safety and compatibility

- [ ] No secret, live ledger, private transcript or workstation path
- [ ] No provider or adopter ontology added to Core
- [ ] No implicit effect or commitment-completion authority
- [ ] Migration, retry, audit, cursor and clock boundaries preserved
- [ ] External gates remain external and no unsupported surface is claimed

## Handoff

Name remaining external evidence, irreversible operator action or known
follow-up. Write `none` when the change is complete.
