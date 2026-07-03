"use client";

import { useArgusStore } from "@/src/store/useArgusStore";

/** Cursor-following chip previewing what a double-click selects. */
export default function SelectHint() {
  const hint = useArgusStore((s) => s.hoverHint);
  const hovered = useArgusStore((s) => s.hovered);
  if (!hint || hovered) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 whitespace-nowrap border border-[var(--color-hairline)] bg-[var(--color-surface)]/95 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-muted)]"
      style={{ left: hint.x + 14, top: hint.y + 14 }}
    >
      {hint.text}
    </div>
  );
}
