/**
 * UUIDv7 generation — time-ordered, sortable, globally unique.
 *
 * Why UUIDv7 over v4: lexicographic sort = creation-time sort. Better DB
 * locality (sequential inserts), better debugging (eyeball-sortable),
 * still globally unique with 74 bits of randomness.
 *
 * No external dependency: we implement the 16-byte layout ourselves.
 * Bun + Node both expose crypto.getRandomValues globally on globalThis.crypto.
 *
 * Layout (RFC 9562 §5.7):
 *   - 48 bits  unix-ms timestamp (big-endian)
 *   - 4 bits   version (0b0111 = 7)
 *   - 12 bits  randomness (rand_a)
 *   - 2 bits   variant (0b10)
 *   - 62 bits  randomness (rand_b)
 *
 * Output: canonical 8-4-4-4-12 hex string, e.g.
 *   "0190b5a3-9f0e-7000-9b8d-3c4d5e6f7a8b"
 */

import { systemClock } from "./clock.js";

const HEX_CHARS = "0123456789abcdef" as const;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX_CHARS[b >>> 4];
    out += HEX_CHARS[b & 0x0f];
  }
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/** Generate a UUIDv7. Pass `nowMs` for deterministic generation. */
export function uuidv7(nowMs: number = systemClock.now()): string {
  const bytes = new Uint8Array(16);

  // 48-bit big-endian unix-ms timestamp at offset 0..5
  // JS numbers are safe to 2^53, so we shift in two halves to avoid bitwise truncation at 32 bits.
  const ms = Math.trunc(nowMs);
  const high = Math.floor(ms / 0x1_0000_0000); // top 16 bits of the 48-bit ms
  const low = ms - high * 0x1_0000_0000; // bottom 32 bits

  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;

  // 10 bytes of randomness
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  // bytes[6]: version (0b0111) << 4 | rand_a high 4 bits
  bytes[6] = 0x70 | ((rand[0] as number) & 0x0f);
  // bytes[7]: rand_a low 8 bits
  bytes[7] = rand[1] as number;
  // bytes[8]: variant (0b10) << 6 | rand_b high 6 bits
  bytes[8] = 0x80 | ((rand[2] as number) & 0x3f);
  // bytes[9..15]: rand_b
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = rand[3 + i] as number;
  }

  return formatUuid(bytes);
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function isUuidv7(value: string): boolean {
  if (!isUuid(value)) return false;
  // version nibble is the first hex char of the 3rd group
  return value[14] === "7";
}

/**
 * Extract the timestamp embedded in a UUIDv7. Returns unix-ms.
 * Throws if the input is not a valid UUIDv7.
 */
/**
 * Render a UUIDv7 as a resolvable human-friendly prefix.
 *
 * Eight characters are not enough for UUIDv7: they contain only the high
 * 32 bits of the timestamp and therefore stay identical for roughly 49.7
 * days. Include the complete millisecond timestamp plus the version/random
 * group so projections do not print the same unusable token for an entire
 * import batch. Prefix resolution still works unchanged.
 */
export function shortId(uuid: string): string {
  return uuid.slice(0, 18);
}

export function timestampFromUuidv7(uuid: string): number {
  if (!isUuidv7(uuid)) {
    throw new Error(`Not a valid UUIDv7: ${uuid}`);
  }
  // First 12 hex chars = 48-bit timestamp
  const hex = uuid.slice(0, 8) + uuid.slice(9, 13);
  // Use Number parsing in two halves to keep safe-integer arithmetic
  const high = parseInt(hex.slice(0, 4), 16);
  const low = parseInt(hex.slice(4, 12), 16);
  return high * 0x1_0000_0000 + low;
}
