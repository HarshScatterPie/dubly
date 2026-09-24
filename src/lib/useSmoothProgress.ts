import { useEffect, useRef, useState } from 'react';

const TICK_MS = 150;
// How far past the last real server value the bar may drift while waiting for the next one.
const MAX_CREEP_AHEAD = 6;
// Drift speed per tick while waiting; slows as it nears the cap so it never visibly stalls or overshoots.
const CREEP_PER_TICK = 0.12;

// Turns coarse server progress (jumps of 5-10%) into a bar that climbs about 1% at a time and keeps gently moving between updates.
export function useSmoothProgress(target: number, active: boolean): number {
  const [shown, setShown] = useState(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!active) {
      setShown(target);
      return;
    }
    const timer = setInterval(() => {
      setShown((prev) => {
        const real = targetRef.current;
        if (real >= 100) return 100;
        // A fresh run reset the real value; follow it down rather than holding a stale number.
        if (prev > real + MAX_CREEP_AHEAD) return real;
        // Catch up to real progress one step at a time instead of jumping.
        if (prev < real) return Math.min(real, prev + Math.max(0.6, (real - prev) * 0.18));
        const cap = Math.min(99, real + MAX_CREEP_AHEAD);
        if (prev >= cap) return prev;
        return Math.min(cap, prev + CREEP_PER_TICK * (1 - (prev - real) / MAX_CREEP_AHEAD) + 0.02);
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return Math.floor(shown);
}
