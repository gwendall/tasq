import {
  clockNow,
  systemClock,
  type Clock,
} from "@tasq/schema";

export interface ClockOptions {
  clock?: Clock;
}

/** Service boundary for wall-clock reads. */
export function serviceNow(options: ClockOptions = {}, explicit?: number): number {
  return clockNow(options.clock ?? systemClock, explicit);
}
