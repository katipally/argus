"use client";

import { useEffect, useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { layerManager } from "@/src/layers/registry";

interface Tick {
  layerId: string;
  label: string;
  color: string;
  title: string;
  severity: number;
  center: [number, number];
}

const w = () => window as unknown as { argusMap?: import("maplibre-gl").Map };

// Bottom edge ticker: the most notable live events across every enabled layer,
// highest-severity first. Click one to fly there. Sampled from what's actually
// rendered, so it always matches the map. Refreshes on a gentle interval.
export default function EventTicker() {
  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  const [ticks, setTicks] = useState<Tick[]>([]);

  useEffect(() => {
    const sample = () => {
      const map = w().argusMap;
      if (!map) return;
      const out: Tick[] = [];
      for (const id of order) {
        const l = layers[id];
        if (!l?.enabled) continue;
        let feats;
        try {
          feats = map.querySourceFeatures(`${id}-src`);
        } catch {
          continue;
        }
        const seen = new Set<string>();
        for (const f of feats) {
          const p = f.properties ?? {};
          if (p.point_count) continue;
          const title = String(p.title ?? p.name ?? p.place ?? "").trim();
          if (!title || seen.has(title)) continue;
          seen.add(title);
          const g = f.geometry;
          const center: [number, number] = g.type === "Point" ? [g.coordinates[0], g.coordinates[1]] : [0, 0];
          out.push({ layerId: id, label: l.label, color: l.color, title, severity: Number(p.severity) || 0, center });
        }
      }
      out.sort((a, b) => b.severity - a.severity);
      setTicks(out.slice(0, 18));
    };
    sample();
    const t = setInterval(sample, 6000);
    return () => clearInterval(t);
  }, [layers, order]);

  if (ticks.length === 0) return null;

  // duplicate the list so the marquee scroll is seamless
  const items = [...ticks, ...ticks];

  return (
    <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-0 flex h-7 items-center overflow-hidden border-t border-[var(--color-hairline)] bg-[color-mix(in_srgb,#06090f_55%,transparent)] backdrop-blur-md">
      <span className="label pointer-events-none z-10 shrink-0 bg-[color-mix(in_srgb,#06090f_78%,transparent)] px-3 backdrop-blur-md !text-[var(--color-accent)]">live feed</span>
      <div className="argus-marquee flex shrink-0 items-center gap-6 whitespace-nowrap pl-4">
        {items.map((t, i) => (
          <button
            key={i}
            onClick={() => layerManager.flyTo({ center: t.center, zoom: 7 })}
            className="pointer-events-auto flex items-center gap-2 text-[11px] tracking-wide"
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
            <span className="text-[var(--color-faint)]">{t.label}</span>
            <span className="text-[var(--color-muted)]">{t.title.length > 48 ? t.title.slice(0, 48) + "…" : t.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
