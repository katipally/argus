"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { layerManager } from "@/src/layers/registry";
import { buildSitrep, type Sitrep, type SitrepEvent } from "@/src/core/sitrep";
import { exportGeoJSON, exportBrief } from "@/src/core/export";

const w = () => window as unknown as { argusMap?: import("maplibre-gl").Map };

/** Per-area situation dashboard — appears when an AOI is set. */
export default function SitrepPanel() {
  const aoi = useArgusStore((s) => s.aoi);
  const [rep, setRep] = useState<Sitrep | null>(null);
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (aoi && ref.current) {
        gsap.fromTo(ref.current, { x: 32, opacity: 0 }, { x: 0, opacity: 1, duration: 0.38, ease: "power3.out" });
      }
    },
    { dependencies: [aoi?.label], scope: ref },
  );

  useEffect(() => {
    if (!aoi) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRep(null);
      return;
    }
    let raf = 0;
    const sample = () => {
      const map = w().argusMap;
      if (map) setRep(buildSitrep(map));
    };
    // defer the first sample out of the effect body (avoids a synchronous cascade)
    raf = requestAnimationFrame(sample);
    const t = setInterval(sample, 6000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, [aoi]);

  if (!aoi || !rep) return null;

  const fly = (e: SitrepEvent) => {
    layerManager.flyTo({ center: e.center, zoom: 9 });
    useArgusStore.getState().setSelected({
      layerId: e.layerId,
      title: e.title,
      subtitle: e.layerLabel,
      rows: [],
      color: e.color,
      center: e.center,
      imageUrl: e.imageUrl,
      streamUrl: e.streamUrl,
      url: e.url,
    });
  };

  return (
    <div ref={ref} className="panel pointer-events-auto w-80 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 pb-2 pt-3.5 text-left"
      >
        <div className="min-w-0">
          <span className="label">sitrep</span>
          <div className="truncate text-[14px] font-semibold text-[var(--color-text)]">◎ {aoi.label}</div>
        </div>
        <span className="text-[var(--color-faint)]">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <>
          <div className="divider mx-4" />
          {/* per-layer live counts + sparkline */}
          <div className="flex flex-col gap-1 px-4 py-2.5">
            {rep.layers.length === 0 && (
              <div className="py-1 text-[11px] text-[var(--color-faint)]">no layers enabled — toggle some in LAYERS</div>
            )}
            {rep.layers.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: l.color }} />
                  <span className="label truncate">{l.label}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Sparkline data={l.history} color={l.color} />
                  <span className="tnum w-10 text-right text-[12px]" style={{ color: l.status === "down" ? "var(--color-alert)" : "var(--color-muted)" }}>
                    {l.status === "loading" ? "···" : l.status === "down" ? "down" : l.count}
                  </span>
                </span>
              </div>
            ))}
          </div>

          {rep.topEvents.length > 0 && (
            <>
              <div className="divider mx-4" />
              <div className="thin-scroll max-h-44 overflow-y-auto px-2 py-2">
                <div className="label px-2 pb-1">top events</div>
                {rep.topEvents.map((e, i) => (
                  <EventRow key={i} e={e} onClick={() => fly(e)} />
                ))}
              </div>
            </>
          )}

          {rep.cameras.length > 0 && (
            <>
              <div className="divider mx-4" />
              <div className="px-2 py-2">
                <div className="label px-2 pb-1">nearest cameras</div>
                {rep.cameras.map((e, i) => (
                  <EventRow key={i} e={e} onClick={() => fly(e)} icon="▶" />
                ))}
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5 px-4 pb-3 pt-1">
            <div className="grid grid-cols-3 gap-1.5">
              <ShareButton />
              <button
                onClick={() => { const m = w().argusMap; if (m) exportGeoJSON(m); }}
                title="Download every enabled layer's rendered features as GeoJSON"
                className="rounded-md border border-[var(--color-hairline-strong)] py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
              >
                geojson ↓
              </button>
              <button
                onClick={() => { const m = w().argusMap; if (m) exportBrief(m); }}
                title="Download this sitrep as a markdown brief"
                className="rounded-md border border-[var(--color-hairline-strong)] py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
              >
                brief ↓
              </button>
            </div>
            <button
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("argus:ask", {
                    detail: `Give me a situation briefing for ${aoi.label}.`,
                  }),
                )
              }
              className="w-full rounded-md border border-[var(--color-hairline-strong)] py-2 text-[11px] uppercase tracking-widest text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
            >
              ✦ Ask Argus about this area
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Copies the shareable URL (hash is kept in sync by urlState). */
function ShareButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      title="Copy a link that reopens this exact view (area, layers, basemap)"
      className="rounded-md border border-[var(--color-hairline-strong)] py-1.5 text-[10px] uppercase tracking-wider transition-colors"
      style={{ color: copied ? "var(--color-live)" : "var(--color-muted)" }}
    >
      {copied ? "copied ✓" : "share ⧉"}
    </button>
  );
}

function EventRow({ e, onClick, icon }: { e: SitrepEvent; onClick: () => void; icon?: string }) {
  const setTiePoint = useArgusStore((s) => s.setTiePoint);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setTiePoint(e.center)}
      onMouseLeave={() => setTiePoint(null)}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-white/[0.04]"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.color }} />
      {icon && <span className="shrink-0 text-[var(--color-faint)]">{icon}</span>}
      <span className="truncate text-[var(--color-muted)]">{e.title}</span>
      {e.severity >= 3 && <span className="shrink-0 text-[var(--color-alert)]">⚠</span>}
    </button>
  );
}

/** Tiny inline SVG sparkline — no chart dependency. */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <span className="w-12" />;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 46},${12 - (v / max) * 11}`).join(" ");
  return (
    <svg width="48" height="14" className="shrink-0 opacity-70">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1" />
    </svg>
  );
}
