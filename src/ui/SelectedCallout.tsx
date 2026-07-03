"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";
import EntityPanel from "./EntityPanel";

// The clicked entity's panel, geo-anchored beside its map point with a leader
// line (same pattern as PinnedPanels) instead of living in the right rail.
// Re-projects on every map move; draggable by its header (offset is kept
// relative to the anchor, so it stays tied to the location); clamps into view.

const PANEL_W = 288; // EntityPanel min width
const EDGE = 12;
const GAP = 26; // px between anchor point and panel edge

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function argusMap(): MlMap | null {
  return (window as unknown as { argusMap?: MlMap }).argusMap ?? null;
}

export default function SelectedCallout() {
  const selected = useArgusStore((s) => s.selected);
  const [, setTick] = useState(0);
  const [off, setOff] = useState({ dx: 0, dy: 0 }); // drag offset from anchor
  const drag = useRef<{ startX: number; startY: number; dx: number; dy: number } | null>(null);
  const entityKey = selected ? `${selected.layerId}:${selected.title}` : "";

  // new entity → forget the previous drag offset
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOff({ dx: 0, dy: 0 });
  }, [entityKey]);

  useEffect(() => {
    if (!selected) return;
    const map = argusMap();
    if (!map) return;
    const bump = () => setTick((n) => n + 1);
    map.on("move", bump);
    return () => {
      map.off("move", bump);
    };
  }, [selected]);

  if (!selected) return null;
  const map = argusMap();
  if (!map) return null;

  const canvas = map.getCanvas();
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  const pt = map.project(selected.center as [number, number]);
  const x = clamp(pt.x, EDGE, vw - EDGE);
  const y = clamp(pt.y, EDGE, vh - EDGE);

  // prefer right of the point; flip to the left when there's no room
  const flip = x + GAP + PANEL_W > vw - EDGE;
  const baseX = flip ? clamp(x - GAP - PANEL_W, EDGE, vw - PANEL_W - EDGE) : x + GAP;
  const px = clamp(baseX + off.dx, EDGE, vw - PANEL_W - EDGE);
  const py = clamp(y - 48 + off.dy, EDGE, Math.max(EDGE, vh - EDGE - 160));
  const maxH = vh - py - 88; // stay clear of the bottom omnibox strip

  const dragProps = {
    onPointerDown: (ev: React.PointerEvent) => {
      drag.current = { startX: ev.clientX, startY: ev.clientY, dx: off.dx, dy: off.dy };
      (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    },
    onPointerMove: (ev: React.PointerEvent) => {
      if (!drag.current) return;
      setOff({
        dx: drag.current.dx + (ev.clientX - drag.current.startX),
        dy: drag.current.dy + (ev.clientY - drag.current.startY),
      });
    },
    onPointerUp: () => {
      drag.current = null;
    },
  };

  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full">
        <g stroke={selected.color} opacity={0.6}>
          <line
            x1={x}
            y1={y}
            x2={px + (px < x ? PANEL_W : 0)}
            y2={py + 20}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          <circle cx={x} cy={y} r={3.5} fill={selected.color} stroke="none" />
        </g>
      </svg>
      <div className="absolute z-20" style={{ left: px, top: py }}>
        <EntityPanel dragProps={dragProps} maxHeight={maxH} />
      </div>
    </>
  );
}
