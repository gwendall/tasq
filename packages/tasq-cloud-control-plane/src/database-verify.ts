import { verifyCloudDatabaseMigration } from "./database-snapshot.js";
import { pathToFileURL } from "node:url";

const [snapshotPath, observedAt, sourceRef, targetRef] = process.argv.slice(2);
if (!snapshotPath || !observedAt || !sourceRef || !targetRef) {
  throw new Error(
    "usage: database-verify.ts <snapshot-file> <observed-at-rfc3339> <source-ref> <target-ref>",
  );
}
const targetUrl = process.env.TASQ_CLOUD_DATABASE_URL?.trim();
const targetAuthToken = process.env.TASQ_CLOUD_DATABASE_AUTH_TOKEN?.trim();
if (!targetUrl || !targetAuthToken) {
  throw new Error("remote database URL and auth token are required through environment variables");
}

const receipt = await verifyCloudDatabaseMigration({
  source: { url: pathToFileURL(snapshotPath).href },
  target: { url: targetUrl, authToken: targetAuthToken },
  observedAt,
  sourceRef,
  targetRef,
});
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
