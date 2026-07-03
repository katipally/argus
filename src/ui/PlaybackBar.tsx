"use client";

import { useEffect, useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";

const DAY = 24 * 3600_000;

/** 24h time scrubber — replay the last day of ts-carrying events (quakes,
 *  news, fires, unrest, cyclones…). Toggled from the status strip. */
export default function PlaybackBar() {
  const playback = useArgusStore((s) => s.playback);
  const setPlayback = useArgusStore((s) => s.setPlayback);
  const [now, setNow] = useState(0);
  useEffect(() => {
    // sync with the wall clock (external system) — initial tick + slow refresh
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!playback.active || now === 0) return null;

  const offset = Math.min(0, Math.max(-DAY, playback.t - now));
  const label =
    offset >= -60_000 ? "live" : `-${Math.floor(-offset / 3600_000)}h ${Math.floor((-offset % 3600_000) / 60_000)}m`;

  return (
    <div className="panel pointer-events-auto absolute left-1/2 top-5 z-20 flex w-[420px] -translate-x-1/2 items-center gap-3 px-4 py-2 animate-[argus-rise_0.15s_ease-out]">
      <span className="label shrink-0">Replay 24h</span>
      <input
        type="range"
        min={-DAY}
        max={0}
        step={5 * 60_000}
        value={offset}
        onChange={(e) => setPlayback({ t: now + Number(e.target.value) })}
        className="flex-1 accent-[var(--color-accent)]"
      />
      <span className="tnum w-16 text-right text-[11px] text-[var(--color-accent)]">{label}</span>
      <button
        onClick={() => setPlayback({ active: false, t: 0 })}
        className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
        title="Exit replay"
      >
        ✕
      </button>
    </div>
  );
}
