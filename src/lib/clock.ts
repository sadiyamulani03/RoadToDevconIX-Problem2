/**
 * Injectable clock. All time-dependent validation receives an explicit
 * `Date` or a `Clock`, so tests are deterministic and never depend on
 * wall-clock timing.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(isoInstant: string): Clock {
  const fixedMs = new Date(isoInstant).getTime();
  if (!Number.isFinite(fixedMs)) {
    throw new Error(`fixedClock received an invalid instant: ${isoInstant}`);
  }
  return { now: () => new Date(fixedMs) };
}

export function offsetClock(startIsoInstant: string, offsetsMs: number[]): Clock {
  const startMs = new Date(startIsoInstant).getTime();
  if (!Number.isFinite(startMs)) {
    throw new Error(`offsetClock received an invalid instant: ${startIsoInstant}`);
  }
  let calls = 0;
  return {
    now: () => {
      const offset = offsetsMs[Math.min(calls, offsetsMs.length - 1)] ?? 0;
      calls += 1;
      return new Date(startMs + offset);
    },
  };
}
