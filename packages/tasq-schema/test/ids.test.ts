/**
 * UUIDv7 tests — round-trip, ordering, format, helpers.
 *
 * UUIDv7 is the foundation of the tasq ID system. If these break, all
 * downstream invariants (lexicographic = chronologic, FK refs, audit
 * ordering) fall over. Test them thoroughly.
 */

import { describe, expect, it } from "bun:test";
import { uuidv7, isUuid, isUuidv7, timestampFromUuidv7 } from "../src/ids.js";

describe("uuidv7 format", () => {
  it("produces canonical 8-4-4-4-12 hex form", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("has version nibble = 7", () => {
    const id = uuidv7();
    // chars 14 is the version nibble (first char of 3rd group)
    expect(id[14]).toBe("7");
  });

  it("has variant bits = 10xx (chars 19 in [89ab])", () => {
    const id = uuidv7();
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("isUuid returns true for valid UUIDs", () => {
    expect(isUuid("01900000-0000-7000-8000-000000000000")).toBe(true);
    expect(isUuid(uuidv7())).toBe(true);
  });

  it("isUuid returns false for invalid input", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("01900000-0000-7000-8000-00000000000")).toBe(false); // 11 chars in last group
    expect(isUuid("01900000-0000-7000-8000-0000000000000")).toBe(false); // 13 chars
    expect(isUuid("ZZZZZZZZ-0000-7000-8000-000000000000")).toBe(false); // non-hex
  });

  it("isUuidv7 distinguishes v7 from v4", () => {
    const v7 = "01900000-0000-7000-8000-000000000000";
    const v4 = "01900000-0000-4000-8000-000000000000";
    expect(isUuidv7(v7)).toBe(true);
    expect(isUuidv7(v4)).toBe(false);
  });
});

describe("uuidv7 time-encoding", () => {
  it("encodes the provided timestamp losslessly", () => {
    const ms = 1_750_000_000_000; // 2025-06-15T12:53:20Z, well above 32-bit range
    const id = uuidv7(ms);
    expect(timestampFromUuidv7(id)).toBe(ms);
  });

  it("supports unix-ms timestamps near upper bound", () => {
    // 48-bit unsigned max = 2^48 - 1 ≈ year 10889 — but JS Date is safe to year 275760
    const ms = 99_999_999_999_999; // year ~5138
    const id = uuidv7(ms);
    expect(timestampFromUuidv7(id)).toBe(ms);
  });

  it("encodes Date.now() consistently", () => {
    const now = Date.now();
    const id = uuidv7(now);
    expect(timestampFromUuidv7(id)).toBe(now);
  });

  it("throws on non-v7 UUIDs", () => {
    expect(() => timestampFromUuidv7("01900000-0000-4000-8000-000000000000")).toThrow(/UUIDv7/);
    expect(() => timestampFromUuidv7("not-a-uuid")).toThrow();
  });
});

describe("uuidv7 ordering", () => {
  it("ids generated at increasing timestamps sort lexicographically", () => {
    const ids = [
      uuidv7(1_700_000_000_000),
      uuidv7(1_700_000_000_001),
      uuidv7(1_700_000_001_000),
      uuidv7(1_700_001_000_000),
      uuidv7(1_800_000_000_000),
    ];
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it("ids generated rapidly in sequence are still strictly time-ordered when ms differ", () => {
    const t = Date.now();
    const a = uuidv7(t);
    const b = uuidv7(t + 1);
    expect(b > a).toBe(true);
  });

  it("two ids at same ms are not guaranteed ordered but are distinct (74 random bits)", () => {
    const t = 1_700_000_000_000;
    const a = uuidv7(t);
    const b = uuidv7(t);
    expect(a).not.toBe(b);
    // Both extract the same ms
    expect(timestampFromUuidv7(a)).toBe(timestampFromUuidv7(b));
  });
});

describe("uuidv7 entropy", () => {
  it("1000 ids in a tight loop are all unique", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(uuidv7());
    expect(set.size).toBe(1000);
  });
});
