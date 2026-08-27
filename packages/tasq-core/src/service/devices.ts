/**
 * Which device said it was this principal.
 *
 * `--actor gwendall` is a claim with nothing behind it. Locally that is not a
 * hole worth patching: anyone who can pass the flag can also open the SQLite
 * file directly, so the trust boundary is the OS account and a login here
 * would be theatre.
 *
 * The defect that IS real, and is already here, is quieter. The principal is
 * derived from (space, alias), so two people or two machines using "gwendall"
 * are literally one principal and the ledger merges them without a word. On a
 * shared or replicated store that silence is the whole problem, and it cannot
 * be reconstructed after the fact: nothing in the history says which machine
 * wrote which row.
 *
 * So this records the device behind each write. It authenticates nobody. It
 * makes the collision observable, which is the part that has to exist before
 * signing the decisive acts can mean anything.
 *
 * The host records it, once per process, only when that process actually
 * committed something. That is deliberate: threading a device through every
 * attribution call site would have covered some writes and not others, with no
 * way for a reader to tell which - a half-truth in the one table whose whole
 * job is to say who wrote what.
 */

import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { PrincipalDevice, principalDevice } from "@tasq-run/schema";
import type { TasqDbOrTx } from "../db.js";

/** The device identity a host presents. The private half never reaches here. */
export interface DeviceIdentity {
  algorithm: "ed25519";
  /** SPKI DER, base64. */
  publicKey: string;
}

/**
 * Domain-separated so a fingerprint can never be confused with a bare hash of
 * the same bytes computed for another purpose.
 */
export function deviceFingerprint(identity: DeviceIdentity): string {
  return createHash("sha256")
    .update("tasq.device.v1\0", "utf8")
    .update(identity.algorithm, "utf8")
    .update("\0", "utf8")
    .update(identity.publicKey, "utf8")
    .digest("hex");
}

/** The first 12 hex characters, which is what a human is asked to compare. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

/**
 * Record that this device acted as this principal, inside the caller's
 * transaction.
 *
 * Deliberately best-effort on the UPDATE side: bumping `last_seen_at` must
 * never be able to fail a mutation the user asked for. The INSERT is what
 * matters, and it happens once per (principal, device).
 */
export async function recordPrincipalDevice(
  db: TasqDbOrTx,
  tenantId: string,
  principalId: string,
  identity: DeviceIdentity,
  now: number,
): Promise<string> {
  const fingerprint = deviceFingerprint(identity);
  await db.insert(principalDevice).values({
    tenantId,
    principalId,
    fingerprint,
    algorithm: identity.algorithm,
    publicKey: identity.publicKey,
    firstSeenAt: now,
    lastSeenAt: now,
  }).onConflictDoUpdate({
    target: [principalDevice.tenantId, principalDevice.principalId, principalDevice.fingerprint],
    set: { lastSeenAt: now },
  });
  return fingerprint;
}

/** Every device that has written as this principal, most recent first. */
export async function devicesForPrincipal(
  db: TasqDbOrTx,
  tenantId: string,
  principalId: string,
): Promise<PrincipalDevice[]> {
  const rows = await db.select().from(principalDevice)
    .where(and(
      eq(principalDevice.tenantId, tenantId),
      eq(principalDevice.principalId, principalId),
    ))
    .orderBy(desc(principalDevice.lastSeenAt));
  return rows.map((row) => PrincipalDevice.parse(row));
}

/**
 * Principals that more than one device has written as.
 *
 * This is the question the whole table exists to answer. It is reported, never
 * refused: one person on a laptop and a desktop is the same situation as two
 * people sharing a label, and the ledger cannot tell them apart. Only the
 * operator can, and only if they are told.
 */
export async function sharedPrincipals(
  db: TasqDbOrTx,
  tenantId: string,
): Promise<Array<{ principalId: string; devices: PrincipalDevice[] }>> {
  const rows = await db.select().from(principalDevice)
    .where(eq(principalDevice.tenantId, tenantId))
    .orderBy(desc(principalDevice.lastSeenAt));
  const byPrincipal = new Map<string, PrincipalDevice[]>();
  for (const row of rows) {
    const parsed = PrincipalDevice.parse(row);
    const list = byPrincipal.get(parsed.principalId) ?? [];
    list.push(parsed);
    byPrincipal.set(parsed.principalId, list);
  }
  return [...byPrincipal.entries()]
    .filter(([, devices]) => devices.length > 1)
    .map(([principalId, devices]) => ({ principalId, devices }))
    .sort((a, b) => a.principalId.localeCompare(b.principalId));
}
