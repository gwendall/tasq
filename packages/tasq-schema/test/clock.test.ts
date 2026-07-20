import { describe, expect, it } from "bun:test";
import { clockNow, createMutableClock } from "../src/clock.js";

describe("injectable clock", () => {
  it("supports deterministic snapshots, advancement and explicit overrides", () => {
    const clock = createMutableClock(1_800_000_000_000);

    expect(clock.now()).toBe(1_800_000_000_000);
    expect(clockNow(clock)).toBe(1_800_000_000_000);
    expect(clockNow(clock, 42)).toBe(42);

    clock.advance(2_500);
    expect(clock.now()).toBe(1_800_000_002_500);
    clock.set(1_900_000_000_000);
    expect(clock.now()).toBe(1_900_000_000_000);
  });

  it("rejects invalid time and advancement values", () => {
    expect(() => createMutableClock(-1)).toThrow(/non-negative unix-ms/);
    const clock = createMutableClock(10);
    expect(() => clock.set(Number.NaN)).toThrow(/non-negative unix-ms/);
    expect(() => clock.advance(-11)).toThrow(/non-negative unix-ms/);
  });
});
