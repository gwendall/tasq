# `@tasq-internal/life-planning-profile`

Private, DB-free reference policy for the bundled personal-planning
composition. It owns area/goal/project/task ancestry, prioritization,
recurrence and Markdown projection without making those concepts mandatory
universal-kernel ontology.

The package consumes structural inputs and explicit timestamps only. It must
not import a database, service, connector or runtime. New adopter-specific
policy belongs in another profile rather than in Core.

```bash
pnpm --filter @tasq-internal/life-planning-profile typecheck
pnpm --filter @tasq-internal/life-planning-profile test
```
