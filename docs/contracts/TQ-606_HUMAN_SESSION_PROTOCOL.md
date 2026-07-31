# TQ-606 — Independent blind-human session protocol

This protocol prepares the sole external TQ-606 gate. It does not replace the
session and cannot make the gate pass without an unfamiliar external human.

## Activation outcome

The participant reaches first value when a human and an agent coordinate on
one ledger, recover an intentional resource contention, attach evidence and
complete explicitly. The final proof is that the installed Console shows the
same actors, commitment and recovered resource.

## Before the participant arrives

1. Use a clean supported target: macOS ARM64 or Linux x64 GNU.
2. Ensure only the public internet entrypoint is available. Do not open this
   repository, private notes, unpublished commands or a prepared ledger.
3. Copy
   [`TQ-606_HUMAN_SESSION_EVIDENCE.template.json`](TQ-606_HUMAN_SESSION_EVIDENCE.template.json)
   to a private session working directory.
4. Obtain consent for observation. Use opaque participant and observer
   references. Do not record names, email addresses, secrets, credentials,
   private transcripts or workstation paths in repository evidence.
5. Start observation before providing the only starting material:
   `https://tasq.run`.

## Participant task

Give the participant only this sentence:

> Starting from https://tasq.run, install Tasq, create and onboard a human
> workspace actor, connect an agent to that same workspace, create a commitment
> that needs one exclusive resource, observe and recover a contention between
> the actors, complete the commitment with evidence, and verify the shared
> result in the installed Console.

Do not explain Tasq terminology, select commands, identify documentation links
or repair the environment after the session starts. The participant may use
any documentation discoverable from the public entrypoint. Normal
self-correction remains part of the trial.

## Observer rules

- Record an explicit UTC timestamp for the session boundary and each journey
  checkpoint. The observation record supplies time; Tasq does not treat the
  device clock as authority. Checkpoints must remain strictly ordered, and
  checkpoints, interventions and failures must fall within the recorded
  session interval.
- Record every wrong turn, failure and intervention when it occurs.
- A public-documentation lookup initiated by the participant is valid and
  belongs in `interventions`.
- Facilitator coaching, repository access, an environment repair or any
  undocumented command invalidates independent completion. Continue observing:
  the session still produces a product finding.
- Never omit a failure to make the record pass. Use `recovered_self_service`,
  `recovered_with_help` or `unresolved` exactly.
- Keep raw recordings privately according to participant consent. The
  repository record contains only redacted observations and a SHA-256 digest.

The required ordered checkpoints are:

1. public entrypoint opened;
2. protected `v0.3.0` release installed;
3. human actor onboarded;
4. agent connected to the same workspace;
5. resource contention observed;
6. contention recovered without coaching;
7. evidence-bound explicit completion observed;
8. same-ledger result inspected in the installed Console.

## Record and validate

The evidence format is frozen in
[`TQ-606_HUMAN_SESSION_EVIDENCE.schema.json`](TQ-606_HUMAN_SESSION_EVIDENCE.schema.json).
Keep `interventions` and `failures` as arrays even when empty. One observation
or recording digest may be referenced by multiple checkpoints.

From the repository root, validate a completed redacted record:

```bash
pnpm --silent adoption:validate -- --evidence path/to/redacted-session.json
```

The command exits non-zero for the untouched template, incomplete checkpoints,
coaching, environment repair, unresolved failures, unsafe evidence references,
metric drift or an inaccurate attestation. Its deterministic report can only
set `readyForExternalGateReview`; it deliberately reports
`certificateMutationAuthorized: false`.

After a passing validation, a maintainer still reviews the redacted record and
the private evidence digest. Only that review may update
`TQ-606_ADOPTION_CERTIFICATION.json`, `BACKLOG.json` and their human
companions. The validator never writes product truth or marks TQ-606 complete.
