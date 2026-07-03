"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { buildSitrep, type Sitrep } from "@/src/core/sitrep";
import { layerManager } from "@/src/layers/registry";

// Floating (non-fullscreen) workspace for a right-clicked place. "View more" is
// the primary tab: Wikipedia brief + Wikidata fact table + Commons photo strip +
// nearby POIs + live events from the enabled layers. Reuses the sitrep engine
// and the aggregated /api/place?full=1 — no client-side fan-out.

type Tab = "overview" | "events" | "agent";
const TABS: Tab[] = ["overview", "events", "agent"];

interface PlaceData {
  address: string;
  wiki: { title?: string; extract?: string; thumb?: string; url?: string };
  weather: { temp?: number; desc?: string; wind?: number };
  facts: Record<string, string>;
  gallery: { url: string; title: string }[];
  pois: { name: string; kind: string }[];
}

const POI_ICON: Record<string, string> = { airport: "✈", hospital: "✚", historic: "◆", attraction: "★" };

export default function DetailModal() {
  const place = useArgusStore((s) => s.place);
  const open = useArgusStore((s) => s.detailOpen);
  const setOpen = useArgusStore((s) => s.setDetailOpen);
  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [pd, setPd] = useState<PlaceData | null>(null);
  const [sitrep, setSitrep] = useState<Sitrep | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useGSAP(
    () => {
      if (open && ref.current)
        gsap.fromTo(ref.current, { scale: 0.96, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.25, ease: "power3.out" });
    },
    { dependencies: [open], scope: ref },
  );

  useEffect(() => {
    if (!open || !place) return;
    setPd(null);
    const ctrl = new AbortController();
    const q = new URLSearchParams({ lat: String(place.lat), lon: String(place.lon), full: "1" });
    if (place.zoom != null) q.set("zoom", place.zoom.toFixed(1));
    if (place.scopeKind) q.set("scope", place.scopeKind);
    if (place.scopeName) q.set("title", place.scopeName);
    fetch(`/api/place?${q}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: PlaceData) => setPd(d))
      .catch(() => {});
    const map = (window as unknown as { argusMap?: Parameters<typeof buildSitrep>[0] }).argusMap;
    if (map) {
      try {
        setSitrep(buildSitrep(map));
      } catch {
        /* ignore */
      }
    }
    return () => ctrl.abort();
  }, [open, place]);

  if (!open || !place) return null;

  const activeLayers = order.map((id) => layers[id]).filter((l) => l?.enabled);
  const liveHere = (sitrep?.topEvents ?? []).slice(0, 5);

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center">
      <button aria-label="Close" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/50" />
      <div ref={ref} className="panel relative flex h-[70vh] max-h-[640px] w-[min(720px,88vw)] flex-col overflow-hidden">
        <div className="panel-head">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-[var(--color-text)]">
              {pd?.wiki.title ?? place.scopeName ?? "Place intel"}
            </div>
            <div className="label tnum mt-0.5">{place.lat.toFixed(4)}, {place.lon.toFixed(4)}</div>
          </div>
          <button onClick={() => setOpen(false)} className="text-[var(--color-faint)] hover:text-[var(--color-text)]">✕</button>
        </div>

        <div className="flex gap-1 border-b border-[var(--color-hairline)] px-3 py-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="rounded px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors"
              style={{
                background: tab === t ? "color-mix(in srgb, var(--color-accent) 18%, transparent)" : "transparent",
                color: tab === t ? "var(--color-accent)" : "var(--color-muted)",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto px-4 py-3 text-[12px] text-[var(--color-text)]">
          {tab === "overview" && (
            <div className="flex flex-col gap-3.5">
              {!pd && <div className="flex items-center gap-2 text-[var(--color-muted)]"><span className="argus-spinner" /> gathering intel…</div>}

              {/* LIVE FIRST — events from your enabled layers, then conditions */}
              {liveHere.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="label" style={{ color: "var(--color-accent)" }}>Live in this region</span>
                  {liveHere.map((e, i) => (
                    <button
                      key={i}
                      onClick={() => { setOpen(false); layerManager.flyTo({ center: e.center, zoom: 8 }); }}
                      className="flex items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-white/[0.04]"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} />
                      <span className="flex-1 truncate">{e.title}</span>
                      <span className="text-[10px] uppercase text-[var(--color-faint)]">{e.layerLabel}</span>
                    </button>
                  ))}
                </div>
              )}
              {pd?.weather.temp != null && (
                <div className="flex justify-between">
                  <span className="label">Weather now</span>
                  <span className="tnum text-[11px] text-[var(--color-muted)]">
                    {pd.weather.temp}°C · {pd.weather.desc} · {pd.weather.wind} km/h
                  </span>
                </div>
              )}

              {/* Commons photo strip */}
              {pd && pd.gallery.length > 0 && (
                <div className="thin-scroll flex gap-1.5 overflow-x-auto pb-1">
                  {pd.gallery.map((g) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={g.url}
                      src={g.url}
                      alt={g.title}
                      title={g.title}
                      onClick={() => setLightbox(g.url)}
                      className="h-24 w-32 shrink-0 cursor-pointer rounded object-cover transition-opacity hover:opacity-80"
                    />
                  ))}
                </div>
              )}
              {pd && !pd.gallery.length && pd.wiki.thumb && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pd.wiki.thumb} alt="" className="max-h-48 w-full rounded object-cover" />
              )}

              {pd?.wiki.extract && <p className="leading-relaxed">{pd.wiki.extract}</p>}
              {pd?.address && <div className="text-[11px] text-[var(--color-muted)]">{pd.address}</div>}

              {/* Wikidata fact table */}
              {pd && Object.keys(pd.facts).length > 0 && (
                <div className="flex flex-col border-t border-[var(--color-hairline)]">
                  {Object.entries(pd.facts).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between border-b border-[var(--color-hairline)] py-1.5">
                      <span className="label">{k}</span>
                      {k === "website" ? (
                        <a href={v} target="_blank" rel="noopener noreferrer" className="tnum max-w-[60%] truncate text-[11px] text-[var(--color-accent)]">{v.replace(/^https?:\/\//, "")}</a>
                      ) : (
                        <span className="tnum text-[12px] text-[var(--color-text)]">{v}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* nearby POIs */}
              {pd && pd.pois.length > 0 && (
                <div className="flex flex-col gap-1 border-t border-[var(--color-hairline)] pt-2">
                  <span className="label">Nearby</span>
                  {pd.pois.map((p) => (
                    <span key={p.name} className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                      <span className="w-4 text-center text-[var(--color-faint)]">{POI_ICON[p.kind] ?? "·"}</span>
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-[9px] uppercase text-[var(--color-faint)]">{p.kind}</span>
                    </span>
                  ))}
                </div>
              )}

              {pd?.wiki.url && (
                <a href={pd.wiki.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-[var(--color-accent)]">Wikipedia ↗</a>
              )}
            </div>
          )}

          {tab === "events" && (
            <div className="flex flex-col gap-3">
              {activeLayers.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {activeLayers.map((l) => (
                    <span key={l.id} className="flex items-center gap-1.5 rounded border border-[var(--color-hairline)] px-2 py-0.5 text-[10px]">
                      <span className="h-2 w-2 rounded-full" style={{ background: l.color }} />
                      {l.label}
                      <span className="tnum text-[var(--color-muted)]">{l.count}</span>
                    </span>
                  ))}
                </div>
              )}
              <EventList events={sitrep?.topEvents ?? []} />
            </div>
          )}

          {tab === "agent" && (
            <div className="flex flex-col items-start gap-3">
              <p className="text-[var(--color-muted)]">Hand this place to the Argus agent for a full analysis.</p>
              <button
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new CustomEvent("argus:ask", { detail: `Give me a situation report for ${place.lat.toFixed(3)}, ${place.lon.toFixed(3)} (${pd?.wiki.title ?? "this location"}).` }));
                }}
                className="rounded border border-[var(--color-accent)] px-3 py-1.5 text-[11px] uppercase tracking-wider text-[var(--color-accent)]"
              >
                Ask Argus about this place
              </button>
            </div>
          )}
        </div>
      </div>

      {/* gallery lightbox */}
      {lightbox && (
        <button className="absolute inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.replace(/\/480px-/, "/1280px-")} alt="" className="max-h-[86vh] max-w-[90vw] object-contain" />
        </button>
      )}
    </div>
  );

  function EventList({ events }: { events: Sitrep["topEvents"] }) {
    if (!events.length) return <div className="text-[var(--color-faint)]">Nothing detected nearby (enable layers + set a focus).</div>;
    return (
      <div className="flex flex-col gap-1.5">
        {events.slice(0, 20).map((e, i) => (
          <button
            key={i}
            onClick={() => { setOpen(false); layerManager.flyTo({ center: e.center, zoom: 8 }); }}
            className="flex items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-white/[0.04]"
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} />
            <span className="flex-1 truncate">{e.title}</span>
            <span className="text-[10px] uppercase text-[var(--color-faint)]">{e.layerLabel}</span>
          </button>
        ))}
      </div>
    );
  }
}
