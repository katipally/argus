"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { useArgusStore, type PinnedPanel } from "@/src/store/useArgusStore";
import { layerManager } from "@/src/layers/registry";
import { CameraView } from "./EntityPanel";

// Pinned floating panels: each is geo-anchored to its entity's map point with
// a leader line, draggable by its header, and survives new selections — the
// multi-camera / multi-event monitoring surface. Anchors re-project on every
// map move; anchors that leave the view clamp to the viewport edge so a pinned
// live camera never silently disappears.

const PANEL_W = 232;
const EDGE = 12; // clamp margin, px

function argusMap(): MlMap | null {
  return (window as unknown as { argusMap?: MlMap }).argusMap ?? null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function PinnedPanels() {
  const pinned = useArgusStore((s) => s.pinned);
  // reproject anchors on every map render frame (pan/zoom/rotate/globe spin)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pinned.length) return;
    const map = argusMap();
    if (!map) return;
    const bump = () => setTick((n) => n + 1);
    map.on("move", bump);
    return () => {
      map.off("move", bump);
    };
  }, [pinned.length]);

  if (!pinned.length) return null;
  const map = argusMap();
  if (!map) return null;
  const canvas = map.getCanvas();
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;

  return (
    <>
      {/* leader lines under the panels */}
      <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full">
        {pinned.map((p) => {
          const a = anchorFor(map, p, vw, vh);
          return (
            <g key={p.id} stroke={p.entity.color} opacity={0.55}>
              <line x1={a.x} y1={a.y} x2={a.px + PANEL_W / 2} y2={a.py} strokeWidth={1} strokeDasharray="4 3" />
              <circle cx={a.x} cy={a.y} r={3} fill={p.entity.color} stroke="none" />
            </g>
          );
        })}
      </svg>
      {pinned.map((p) => (
        <Pin key={p.id} pin={p} anchor={anchorFor(map, p, vw, vh)} />
      ))}
    </>
  );
}

/** Projected anchor (clamped into view) + panel top-left for a pin. */
function anchorFor(map: MlMap, p: PinnedPanel, vw: number, vh: number) {
  const pt = map.project(p.entity.center as [number, number]);
  const x = clamp(pt.x, EDGE, vw - EDGE);
  const y = clamp(pt.y, EDGE, vh - EDGE);
  const px = clamp(x + p.dx - PANEL_W / 2, EDGE, vw - PANEL_W - EDGE);
  const py = clamp(y + p.dy, EDGE + 28, vh - EDGE - 60);
  return { x, y, px, py };
}

function Pin({ pin, anchor }: { pin: PinnedPanel; anchor: { x: number; y: number; px: number; py: number } }) {
  const removePin = useArgusStore((s) => s.removePin);
  const movePin = useArgusStore((s) => s.movePin);
  const setSelected = useArgusStore((s) => s.setSelected);
  const drag = useRef<{ startX: number; startY: number; dx: number; dy: number } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const e = pin.entity;

  const onPointerDown = (ev: React.PointerEvent) => {
    drag.current = { startX: ev.clientX, startY: ev.clientY, dx: pin.dx, dy: pin.dy };
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: React.PointerEvent) => {
    if (!drag.current) return;
    movePin(pin.id, drag.current.dx + (ev.clientX - drag.current.startX), drag.current.dy + (ev.clientY - drag.current.startY));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      className="panel pointer-events-auto absolute z-20 overflow-hidden"
      style={{ left: anchor.px, top: anchor.py, width: PANEL_W }}
    >
      <div
        className="flex cursor-grab items-center gap-2 px-3 py-1.5 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ touchAction: "none" }}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} />
        <button
          onClick={() => setSelected(e)}
          className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-[var(--color-text)] hover:text-[var(--color-accent)]"
          title={`${e.title} — open full panel`}
        >
          {e.title}
        </button>
        <div
          className="flex shrink-0 items-center gap-2"
          onPointerDown={(ev) => ev.stopPropagation() /* buttons never start a drag */}
        >
          <button
            onClick={() => layerManager.flyTo({ center: e.center, zoom: 11 })}
            className="text-[11px] text-[var(--color-faint)] hover:text-[var(--color-accent)]"
            aria-label="Fly to"
            title="Fly to"
          >
            ⌖
          </button>
          <button
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("argus:ask", {
                  detail: `Tell me about this event: "${e.title}" at ${e.center[1].toFixed(2)}, ${e.center[0].toFixed(2)} (${e.subtitle ?? e.layerId}). What's the situation and context?`,
                }),
              )
            }
            className="text-[11px] text-[var(--color-faint)] hover:text-[var(--color-accent)]"
            aria-label="Ask Argus"
            title="Ask Argus"
          >
            ✦
          </button>
          {e.url && (
            <a
              href={e.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-[var(--color-faint)] hover:text-[var(--color-accent)]"
              aria-label="Open source"
              title="Open source"
            >
              ↗
            </a>
          )}
          <button
            onClick={() => setMinimized((m) => !m)}
            className="text-[11px] text-[var(--color-faint)] hover:text-[var(--color-text)]"
            aria-label={minimized ? "Expand" : "Minimize"}
            title={minimized ? "Expand" : "Minimize"}
          >
            {minimized ? "▢" : "—"}
          </button>
          <button
            onClick={() => removePin(pin.id)}
            className="text-[11px] text-[var(--color-faint)] hover:text-[var(--color-alert)]"
            aria-label="Unpin"
            title="Unpin"
          >
            ✕
          </button>
        </div>
      </div>
      {minimized ? null : e.embedUrl ? (
        <div className="aspect-video w-full bg-black">
          <iframe
            src={e.embedUrl}
            title={e.title}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            className="h-full w-full border-0"
          />
        </div>
      ) : e.streamUrl || e.imageUrl ? (
        <CameraView key={e.streamUrl ?? e.imageUrl} imageUrl={e.imageUrl ?? ""} streamUrl={e.streamUrl} />
      ) : (
        <div className="flex flex-col gap-0.5 px-3 pb-2">
          {e.rows.slice(0, 3).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <span className="label">{k}</span>
              <span className="tnum truncate text-[11px] text-[var(--color-muted)]">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
