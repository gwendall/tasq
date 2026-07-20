/** A wall-clock source. Domain code depends on this interface, never the device. */
export interface Clock {
  now(): number;
}

/**
 * The sole production adapter allowed to read the host wall clock.
 * Composition roots inject it; tests and deterministic runtimes inject another
 * `Clock` or pass an explicit timestamp.
 */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
});

/** Resolve an explicit domain timestamp before consulting an injected clock. */
export function clockNow(clock: Clock = systemClock, explicit?: number): number {
  return unixMs(explicit ?? clock.now(), "Clock");
}

/** Mutable deterministic clock for tests, simulations and replay. */
export interface MutableClock extends Clock {
  set(now: number): void;
  advance(milliseconds: number): void;
}

export function createMutableClock(initialNow: number): MutableClock {
  let current = unixMs(initialNow, "Initial clock time");
  return {
    now: () => current,
    set: (now) => {
      current = unixMs(now, "Clock time");
    },
    advance: (milliseconds) => {
      if (!Number.isSafeInteger(milliseconds)) {
        throw new Error("Clock advancement must be a safe integer number of milliseconds");
      }
      current = unixMs(current + milliseconds, "Advanced clock time");
    },
  };
}

function unixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return value;
}
