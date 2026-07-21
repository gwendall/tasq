/** Timer injection for transport cadence; domain time always comes from Clock. */

export interface ConsoleScheduler {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

/** Sole production timer adapter. It schedules work but never supplies time. */
export const systemConsoleScheduler: ConsoleScheduler = Object.freeze({
  wait(delayMs: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(finish, delayMs);
      function finish() {
        signal.removeEventListener("abort", abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        finish();
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  },
});
