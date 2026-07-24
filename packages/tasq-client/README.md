# `@tasq-run/client`

Runtime-neutral TypeScript client for an authenticated Tasq Server. It talks
only to the guarded HTTP contract: it never opens a Tasq database, caches
authority, or treats an actor label as authentication.

```ts
import { createRemoteTasq } from "@tasq-run/client";

const tasq = createRemoteTasq({
  endpoint: "https://tasq.example/",
  workspaceId: "team/alpha",
  accessToken: () => process.env.TASQ_ACCESS_TOKEN!,
});

const page = await tasq.listCommitments({ limit: 20 });
```

Use `tasq remote enroll` for the one-use enrollment ceremony and private local
credential storage. See `docs/contracts/TQ-809_REMOTE_CLIENT_AND_ENROLLMENT.md`
for trust, retry, revocation and cursor semantics.
