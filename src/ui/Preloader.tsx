"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";

// Boot preloader driven by REAL milestones (no fake timers):
//   0  · boot            — component mounted
//   36 · interface       — web fonts ready
//   72 · map & terrain   — map created (argus:map-ready from Argus.onMapReady)
//   100· ready           — first map "idle" (style + tiles actually drawn)
// The number only ever shows these 4 values; the bar tweens between them.
// A 12s failsafe forces completion so a slow/failed upstream can never
// deadlock the app behind the overlay.
const STEPS = [0, 36, 72, 100] as const;
const LABELS = ["booting", "interface", "map & terrain", "ready"] as const;

export default function Preloader({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const done = useRef(false);

  // advance() only moves forward — late/out-of-order signals can't regress it
  useEffect(() => {
    const advance = (n: number) => setStep((s) => Math.max(s, n));

    document.fonts.ready.then(() => advance(1));

    const onMapReady = () => {
      advance(2);
      const map = (window as unknown as { argusMap?: MlMap }).argusMap;
      if (map) map.once("idle", () => advance(3));
      else advance(3);
    };
    // map may already exist if this mounted late
    if ((window as unknown as { argusMap?: MlMap }).argusMap) onMapReady();
    else window.addEventListener("argus:map-ready", onMapReady, { once: true });

    const failsafe = setTimeout(() => advance(3), 12_000);
    return () => {
      window.removeEventListener("argus:map-ready", onMapReady);
      clearTimeout(failsafe);
    };
  }, []);

  // finish: let the bar reach 100, then cross-fade out while the HUD rises in
  useEffect(() => {
    if (step < 3 || done.current) return;
    done.current = true;
    const t1 = setTimeout(() => {
      setLeaving(true);
      onDone();
    }, 450);
    const t2 = setTimeout(() => setGone(true), 1250); // after the fade completes
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      done.current = false; // effect re-run (StrictMode / new onDone) re-arms the timers
    };
  }, [step, onDone]);

  if (gone) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-8 transition-opacity duration-700 ease-out"
      style={{
        background: "var(--color-bg)",
        opacity: leaving ? 0 : 1,
        pointerEvents: leaving ? "none" : "auto",
      }}
      aria-busy={!leaving}
      aria-label="Loading Argus"
    >
      <div className="flex items-center gap-3">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-accent)]" />
        </span>
        <span className="font-display text-[22px] font-semibold tracking-[0.35em] text-[var(--color-text)]">
          ARGUS
        </span>
      </div>

      <div className="flex w-64 flex-col items-center gap-3">
        <span className="tnum font-display text-[44px] font-semibold leading-none text-[var(--color-text)]">
          {STEPS[step]}
        </span>
        <div className="h-[2px] w-full overflow-hidden rounded-full bg-[var(--color-hairline)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500 ease-out"
            style={{ width: `${STEPS[step]}%` }}
          />
        </div>
        <span className="label">{LABELS[step]}</span>
      </div>
    </div>
  );
}
