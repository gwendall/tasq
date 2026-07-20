import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diagnoseStore,
  getObservation,
  getObservationByDelivery,
  ingestObservation,
  listObservations,
  openDb,
  runMigrations,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-observations-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

const gmailInput = {
  source: "gmail:primary",
  externalEventId: "delivery-123",
  kind: "gmail.message" as const,
  payload: {
    connectorAccount: "gmail:primary",
    messageId: "message-123",
    threadId: "thread-123",
    sender: "alice@example.test",
  },
  occurredAt: 10_000,
  verificationLevel: "authenticated_source" as const,
  verificationMethod: "oauth2 connector session",
  rawRef: "vault://gmail/message-123",
  digest: "sha256:abc123",
  metadata: { delivery: "webhook" },
};

describe("observation ingestion", () => {
  it("stores canonical payload, derived subject identity, and explicit provenance", async () => {
    const { db, close } = await freshDb();
    try {
      const result = await ingestObservation(db, gmailInput, {
        actor: "watcher:gmail",
        now: 11_000,
      });
      expect(result).toMatchObject({
        tenantId: "gwendall",
        source: "gmail:primary",
        externalEventId: "delivery-123",
        kind: "gmail.message",
        schemaVersion: 1,
        subjectRef: JSON.stringify(["gmail.message", "gmail:primary", "thread-123"]),
        payload: gmailInput.payload,
        occurredAt: 10_000,
        recordedAt: 11_000,
        recordedBy: "watcher:gmail",
        verificationLevel: "authenticated_source",
        verificationMethod: "oauth2 connector session",
      });
      expect(await getObservation(db, result.id)).toEqual(result);
      expect(await getObservationByDelivery(db, "gmail:primary", "delivery-123")).toEqual(
        result,
      );
    } finally {
      await close();
    }
  });

  it("accepts and canonicalizes every initial typed observation kind", async () => {
    const { db, close } = await freshDb();
    try {
      const inputs = [
        gmailInput,
        {
          source: "github:work",
          externalEventId: "gh-1",
          kind: "github.pull_request" as const,
          payload: {
            host: "github.com",
            owner: "kami",
            repository: "robot",
            pullRequestNumber: 42,
            state: "merged" as const,
          },
          occurredAt: 20_000,
        },
        {
          source: "mercury:kami",
          externalEventId: "mercury-1",
          kind: "mercury.transaction" as const,
          payload: {
            connectorAccount: "mercury:kami",
            transactionId: "tx-1",
            direction: "outgoing" as const,
            currency: "USD",
            minorUnits: 58_000_00,
            settlementState: "sent",
          },
          occurredAt: 30_000,
        },
        {
          source: "http:prod",
          externalEventId: "http-1",
          kind: "http.check" as const,
          payload: {
            url: "https://example.test/health",
            method: "GET" as const,
            statusCode: 200,
          },
          occurredAt: 40_000,
        },
        {
          source: "filesystem:workspace",
          externalEventId: "fs-1",
          kind: "filesystem.stat" as const,
          payload: {
            connectorRoot: "workspace",
            relativePath: "dist/release.tar.gz",
            kind: "file" as const,
            sizeBytes: 1234,
          },
          occurredAt: 50_000,
        },
      ];

      const results = [];
      for (const [index, input] of inputs.entries()) {
        results.push(await ingestObservation(db, input, { now: 60_000 + index }));
      }
      expect(results.map((row) => row.kind)).toEqual([
        "gmail.message",
        "github.pull_request",
        "mercury.transaction",
        "http.check",
        "filesystem.stat",
      ]);
      expect(results[1]?.payload.mergeCommitSha).toBeNull();
      expect(results[2]?.payload.counterparty).toBeNull();
      expect(results[3]?.payload.bodyDigest).toBeNull();
      expect(results[4]?.payload.digest).toBeNull();
    } finally {
      await close();
    }
  });

  it("deduplicates identical redelivery but rejects identity/content conflicts", async () => {
    const { db, close } = await freshDb();
    try {
      const first = await ingestObservation(db, gmailInput, {
        actor: "watcher:gmail",
        now: 11_000,
      });
      const replay = await ingestObservation(db, gmailInput, {
        actor: "watcher:gmail:replacement",
        now: 99_000,
      });
      expect(replay).toEqual(first);
      expect(replay.recordedAt).toBe(11_000);
      expect(replay.recordedBy).toBe("watcher:gmail");
      expect(await listObservations(db)).toHaveLength(1);

      await expect(
        ingestObservation(
          db,
          {
            ...gmailInput,
            payload: { ...gmailInput.payload, sender: "mallory@example.test" },
          },
          { now: 100_000 },
        ),
      ).rejects.toThrow(/reused with different content/);
      await expect(
        ingestObservation(
          db,
          { ...gmailInput, verificationLevel: "provider_verified" },
          { now: 100_000 },
        ),
      ).rejects.toThrow(/reused with different content/);
    } finally {
      await close();
    }
  });

  it("deduplicates concurrent delivery and scopes identity by tenant", async () => {
    const { db, close } = await freshDb();
    try {
      const rows = await Promise.all(
        Array.from({ length: 8 }, () => ingestObservation(db, gmailInput, { now: 11_000 })),
      );
      expect(new Set(rows.map((row) => row.id)).size).toBe(1);
      expect(await listObservations(db)).toHaveLength(1);

      const otherTenant = await ingestObservation(db, gmailInput, {
        tenantId: "other",
        now: 12_000,
      });
      expect(otherTenant.id).not.toBe(rows[0]?.id);
      expect(await listObservations(db, { tenantId: "other" })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("rejects malformed typed facts and invalid trust claims", async () => {
    const { db, close } = await freshDb();
    try {
      await expect(
        ingestObservation(db, { ...gmailInput, payload: { threadId: "missing-fields" } }),
      ).rejects.toThrow();
      await expect(
        ingestObservation(db, { ...gmailInput, schemaVersion: 2 }),
      ).rejects.toThrow(/Unsupported observation schema/);
      await expect(
        ingestObservation(db, {
          ...gmailInput,
          verificationLevel: "provider_verified",
          verificationMethod: null,
        }),
      ).rejects.toThrow(/verification method/);
      await expect(
        ingestObservation(db, { ...gmailInput, digest: null }),
      ).rejects.toThrow(/binding digest/);
      await expect(
        ingestObservation(db, { ...gmailInput, source: "   " }),
      ).rejects.toThrow(/source must not be blank/);
    } finally {
      await close();
    }
  });

  it("paginates losslessly when several rows share one recorded millisecond", async () => {
    const { db, close } = await freshDb();
    try {
      for (let index = 0; index < 5; index++) {
        await ingestObservation(
          db,
          {
            ...gmailInput,
            externalEventId: `delivery-${index}`,
            payload: {
              ...gmailInput.payload,
              messageId: `message-${index}`,
            },
          },
          { now: 20_000 },
        );
      }
      const firstPage = await listObservations(db, { ascending: true, limit: 2 });
      const secondPage = await listObservations(db, {
        after: {
          recordedAt: firstPage[1]!.recordedAt,
          id: firstPage[1]!.id,
        },
        limit: 2,
      });
      const thirdPage = await listObservations(db, {
        after: {
          recordedAt: secondPage[1]!.recordedAt,
          id: secondPage[1]!.id,
        },
        limit: 2,
      });
      const all = [...firstPage, ...secondPage, ...thirdPage];
      expect(all).toHaveLength(5);
      expect(new Set(all.map((row) => row.id)).size).toBe(5);
    } finally {
      await close();
    }
  });

  it("filters candidate facts without a Cartesian scan", async () => {
    const { db, close } = await freshDb();
    try {
      const gmail = await ingestObservation(db, gmailInput, { now: 11_000 });
      await ingestObservation(
        db,
        {
          source: "http:prod",
          externalEventId: "http-filter",
          kind: "http.check",
          payload: {
            url: "https://example.test/health",
            method: "GET",
            statusCode: 200,
          },
          occurredAt: 12_000,
        },
        { now: 13_000 },
      );
      expect(
        await listObservations(db, {
          kinds: ["gmail.message"],
          subjectRef: gmail.subjectRef,
          verificationLevels: ["authenticated_source"],
          occurredFrom: 9_000,
          occurredTo: 11_000,
        }),
      ).toEqual([gmail]);
    } finally {
      await close();
    }
  });

  it("is physically append-only and doctor detects canonical payload drift", async () => {
    const { db, client, close } = await freshDb();
    try {
      const row = await ingestObservation(db, gmailInput, { now: 11_000 });
      await expect(
        client.execute({
          sql: "UPDATE observation SET subject_ref='tampered' WHERE id=?",
          args: [row.id],
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        client.execute({ sql: "DELETE FROM observation WHERE id=?", args: [row.id] }),
      ).rejects.toThrow(/append-only/);

      await client.execute("DROP TRIGGER observation_no_update");
      await client.execute({
        sql: "UPDATE observation SET subject_ref='tampered' WHERE id=?",
        args: [row.id],
      });
      const report = await diagnoseStore(db, client);
      expect(report.ok).toBe(false);
      expect(report.issues.map((issue) => issue.code)).toContain(
        "observation_subject_mismatch",
      );
    } finally {
      await close();
    }
  });
});
