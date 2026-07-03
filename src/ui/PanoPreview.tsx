"use client";

import { useArgusStore } from "@/src/store/useArgusStore";
import { panoThumbUrl } from "@/src/map/panoramaxLayer";

/** Small thumbnail popup anchored where a street-imagery dot was clicked.
 *  Click the thumb → full PanoViewer. Closes on ✕ or camera move. */
export default function PanoPreview() {
  const preview = useArgusStore((s) => s.panoPreview);
  const setPanoPreview = useArgusStore((s) => s.setPanoPreview);
  const setPanoImageId = useArgusStore((s) => s.setPanoImageId);
  if (!preview) return null;

  // clamp so the 176px card never leaves the viewport
  const x = Math.min(Math.max(preview.x, 8), (typeof window !== "undefined" ? window.innerWidth : 1200) - 192);
  const y = Math.max(preview.y - 148, 8);

  return (
    <div
      className="panel pointer-events-auto absolute z-30 w-44 overflow-hidden animate-[argus-rise_0.15s_ease-out]"
      style={{ left: x, top: y }}
    >
      <button
        className="group relative block h-24 w-full"
        title="Open street view"
        onClick={() => {
          setPanoImageId({ id: preview.id, source: preview.source });
          setPanoPreview(null);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={panoThumbUrl(preview.id)} alt="street imagery preview" className="h-24 w-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-[20px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          ▶
        </span>
      </button>
      <div className="flex items-center justify-between px-2 py-1">
        <span className="label">street view</span>
        <button
          className="text-[var(--color-faint)] hover:text-[var(--color-text)]"
          onClick={() => setPanoPreview(null)}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
