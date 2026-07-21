import { openAuthorityStore } from "@tasq-internal/server";

const url = process.argv[2];
if (!url) throw new Error("authority store URL required");
const store = await openAuthorityStore({ url, clock: { now: () => 1_800_000_000_000 } });
await store.close();
process.stdout.write(JSON.stringify({ ok: true }));
