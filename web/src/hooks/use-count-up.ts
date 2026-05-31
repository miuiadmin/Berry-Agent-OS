import { useState, useEffect, useRef } from "react";

/**
 * Animated number count-up from 0 → end.
 * Uses requestAnimationFrame with ease-out interpolation.
 * Respects `prefers-reduced-motion` — skips animation and returns end value immediately.
 */
export function useCountUp(end: number, duration = 800): number {
  const [value, setValue] = useState(end);
  const prefersReduced = useRef(
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );

  useEffect(() => {
    // Skip animation if reduced motion is preferred or end is 0
    if (prefersReduced.current || end === 0) {
      setValue(end);
      return;
    }

    const startTime = performance.now();
    let rafId: number;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic: fast start, slow finish
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * end));

      if (progress < 1) {
        rafId = requestAnimationFrame(tick);
      }
    };

    // Start from 0
    setValue(0);
    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [end, duration]);

  return value;
}
