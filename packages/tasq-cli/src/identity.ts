/**
 * This installation's device identity.
 *
 * `--actor gwendall` is a claim with nothing behind it, and locally that is
 * fine: anyone who can pass the flag can also open `db.sqlite` directly, so
 * the trust boundary is the OS account and a login here would be theatre.
 *
 * What is NOT fine is that the principal is derived from (space, alias), so
 * two machines using one label are one principal and the ledger merges them
 * without a word. This gives each installation a key it did not choose, so
 * that merge becomes visible - and so that signing the decisive acts, later,
 * has something to sign with.
 *
 * The private half never leaves this file and is never sent anywhere.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceFingerprint, type DeviceIdentity } from "@tasq-internal/local-service";
import { configDir } from "./config.js";

const FILE = "device.json";
const CONTRACT = "tasq.device-identity.v1";

interface StoredIdentity {
  contractVersion: typeof CONTRACT;
  algorithm: "ed25519";
  /** SPKI DER, base64. */
  publicKey: string;
  /** PKCS8 DER, base64. Never leaves this machine. */
  privateKey: string;
  createdAt: number;
}

export interface LocalDeviceIdentity extends DeviceIdentity {
  fingerprint: string;
  createdAt: number;
  path: string;
}

function identityPath(): string {
  return join(configDir(), FILE);
}

function generate(now: number): StoredIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    contractVersion: CONTRACT,
    algorithm: "ed25519",
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    createdAt: now,
  };
}

function parse(raw: string): StoredIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const stored = value as Partial<StoredIdentity>;
  if (stored.contractVersion !== CONTRACT) return null;
  if (stored.algorithm !== "ed25519") return null;
  if (typeof stored.publicKey !== "string" || typeof stored.privateKey !== "string") return null;
  // A key that does not load is not a key. Better to say so than to hand out a
  // fingerprint for bytes nothing can sign with.
  try {
    createPrivateKey({ key: Buffer.from(stored.privateKey, "base64"), format: "der", type: "pkcs8" });
    createPublicKey({ key: Buffer.from(stored.publicKey, "base64"), format: "der", type: "spki" });
  } catch {
    return null;
  }
  return stored as StoredIdentity;
}

/**
 * Load this installation's identity, creating it on first use.
 *
 * `now` is required rather than defaulted: raw device time belongs to the
 * system clock adapter, and a default here would read the wall clock from
 * inside a call the caller believes is clock-injected.
 *
 * Never throws: a device identity is attribution detail, and no command should
 * fail because a read-only home could not be written to. A host that cannot
 * establish one simply records nothing, which is the state the ledger was in
 * before this existed.
 */
export function loadOrCreateDeviceIdentity(now: number): LocalDeviceIdentity | null {
  const path = identityPath();
  try {
    if (existsSync(path)) {
      const stored = parse(readFileSync(path, "utf8"));
      if (stored) {
        return {
          algorithm: stored.algorithm,
          publicKey: stored.publicKey,
          fingerprint: deviceFingerprint(stored),
          createdAt: stored.createdAt,
          path,
        };
      }
      // Corrupt or foreign: leave it alone rather than silently replacing a
      // key that some other version of this tool may still understand.
      return null;
    }
    const created = generate(now);
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    // Written through a temporary name so a crash mid-write cannot leave a
    // half key that would read as a different device.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(created, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    return {
      algorithm: created.algorithm,
      publicKey: created.publicKey,
      fingerprint: deviceFingerprint(created),
      createdAt: created.createdAt,
      path,
    };
  } catch {
    return null;
  }
}
