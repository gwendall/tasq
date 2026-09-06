# Chat provenance on a commitment

A commitment born from something somebody said in a chat keeps a pointer to
the message, never its text. The pointer is an external context link, which
already exists in the kernel; this guide fixes the vocabulary so that any
runtime attaches the same thing and any reader finds it the same way.

## The vocabulary

| Field | Value |
|---|---|
| `--purpose` | `https://schemas.tasq.dev/context-link-purposes/provenance` for the message that gave rise to the commitment; `.../reporter` for the person who said it; `.../conversation` for the chat or thread; `.../mention` for a later message merged into it |
| `--system` | the platform as an absolute URI: `https://telegram.org`, `https://discord.com`, `https://www.whatsapp.com`, `https://tasq.run/surfaces/web` |
| `--resource-type` | `chat.message`, `chat.user`, `chat.thread` |
| `--external-id` | message: `<chatId>/<messageId>`; user: the platform's canonical user id; thread: `<chatId>` or `<chatId>/<threadId>` |
| `--digest` | `sha256:<hex>` of the verbatim fragment that was captured, so the words can be proven later without being stored |
| `--url` | a stable deep link when the platform has one; never for a direct message |

Names, display names and message text never enter Tasq: an identifier and a
digest are enough to go back to the source and to prove what was captured.

## Attaching

```bash
tasq context-link attach <commitment-id> \
  --purpose https://schemas.tasq.dev/context-link-purposes/provenance \
  --system https://telegram.org --resource-type chat.message --external-id 123456/789 \
  --digest sha256:<hex of the fragment> --idempotency-key intake:<proposal>:provenance
tasq context-link attach <commitment-id> \
  --purpose https://schemas.tasq.dev/context-link-purposes/reporter \
  --system https://telegram.org --resource-type chat.user --external-id 42 \
  --idempotency-key intake:<proposal>:reporter
```

The same message may be attached to several commitments; attaching the same
purpose and target twice to one commitment is refused as a duplicate
projection, which is what an idempotency key is for.

## Finding

Two questions come back constantly and are answered by the target index,
without scanning commitments:

```bash
# Has this message already become a commitment? Which ones?
tasq context-link list --system https://telegram.org --resource-type chat.message --external-id 123456/789 --json
# Who reported this commitment? (count the distinct external ids)
tasq context-link list <commitment-id> --purpose https://schemas.tasq.dev/context-link-purposes/reporter --json
```

Both return `tasq.external-context-link-page.v1`, current links only unless
`--history` is passed. Closing the loop, telling the reporter that what they
said is done, is the reporter listing of the commitment that just completed.
