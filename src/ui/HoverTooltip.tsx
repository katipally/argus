"use client";

import { useArgusStore } from "@/src/store/useArgusStore";

export default function HoverTooltip() {
  const h = useArgusStore((s) => s.hovered);
  if (!h) return null;

  const vw = typeof window !== "undefined" ? window.innerWidth : 2000;
  const vh = typeof window !== "undefined" ? window.innerHeight : 1200;
  const left = Math.min(h.x + 18, vw - 240);
  // flip above the cursor near the bottom edge so the tooltip never clips
  const top = h.y + 18 + 90 + h.rows.length * 18 > vh ? undefined : h.y + 18;
  const bottom = top === undefined ? vh - h.y + 12 : undefined;

  return (
    <div
      className="panel pointer-events-none absolute z-30 w-[220px] px-3 py-2.5"
      style={{ left, top, bottom }}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="h-2 w-2 rounded-sm" style={{ background: h.color }} />
        <span className="truncate text-[12px] font-semibold text-[var(--color-text)]">
          {h.title}
        </span>
      </div>
      {h.rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 py-[1px]">
          <span className="label">{k}</span>
          <span className="tnum text-[11px] text-[var(--color-muted)]">{v}</span>
        </div>
      ))}
      {h.hint && (
        <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
          ▸ {h.hint}
        </div>
      )}
    </div>
  );
}
