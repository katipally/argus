"use client";

import { useArgusStore } from "@/src/store/useArgusStore";

// The selection list. No tabs, no tools — just the regions you've selected.
// Selecting happens on the map (right-click a place); this is where you see
// and remove picks. Empty state explains how to select.
export default function SelectionPanel() {
  const selection = useArgusStore((s) => s.selection);
  const removeShape = useArgusStore((s) => s.removeShape);
  const clearSelection = useArgusStore((s) => s.clearSelection);

  return (
    <div className="panel pointer-events-auto flex w-full shrink-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="label">Focus</span>
        {selection.length > 0 && (
          <button onClick={clearSelection} className="label transition-colors hover:text-[var(--color-accent)]">
            unfocus ✕
          </button>
        )}
      </div>

      {selection.length === 0 ? (
        <div className="px-3 pb-3 text-[11px] leading-relaxed text-[var(--color-faint)]">
          Right-click the map to focus a region — the level follows your zoom
          (continent · country · state · county · city). Shift+right-click adds
          more regions; right-click a focused one to remove it.
        </div>
      ) : (
        <div className="thin-scroll flex max-h-[42vh] flex-col gap-1 overflow-y-auto px-2 pb-2">
          {selection.map((s) => (
            <button
              key={s.id}
              onClick={() => removeShape(s.id)}
              title="Remove"
              className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--color-text)] transition-colors hover:bg-white/[0.04]"
            >
              <span className="text-[var(--color-accent)]">{s.kind === "eez" ? "◈" : "◎"}</span>
              <span className="flex-1 truncate">{s.label}</span>
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-faint)]">{s.kind}</span>
              <span className="text-[var(--color-faint)]">✕</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
