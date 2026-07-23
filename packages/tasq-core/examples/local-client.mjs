import { createLocalTasq, systemClock } from "@tasq-run/core";

const url = process.env.TASQ_DB_URL;
if (!url) throw new Error("Set TASQ_DB_URL=file:/absolute/path/to/db.sqlite");

const tasq = await createLocalTasq({
  url,
  workspaceId: "example/team",
  actor: "app:example",
  clock: systemClock,
});

try {
  let [commitment] = await tasq.commitments.list({ limit: 1 });
  if (!commitment) {
    commitment = await tasq.commitments.create(
      { title: "Ship the embedded Tasq loop" },
      { idempotencyKey: "example:create" },
    );
    commitment = await tasq.commitments.start(commitment.id, {
      expectedRevision: commitment.revision,
      idempotencyKey: "example:start",
    });
    commitment = await tasq.commitments.complete(commitment.id, {
      expectedRevision: commitment.revision,
      idempotencyKey: "example:complete",
    });
  }
  console.log(JSON.stringify({ id: commitment.id, status: commitment.status }));
} finally {
  await tasq.close();
}
