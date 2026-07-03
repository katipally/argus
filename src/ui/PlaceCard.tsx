"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { resolvePlace } from "@/src/geo/resolve";
import { layerManager } from "@/src/layers/registry";
import { buildSitrep, briefLine } from "@/src/core/sitrep";

interface PlaceData {
  lat: number;
  lon: number;
  address: string;
  wiki: { title?: string; extract?: string; thumb?: string; url?: string };
  weather: { temp?: number; desc?: string; wind?: number };
}

// Google-Earth-style card: right-click / long-press any ground point → what is
// this place (Wikipedia), its address (Nominatim), and current weather.
export default function PlaceCard() {
  const place = useArgusStore((s) => s.place);
  const setPlace = useArgusStore((s) => s.setPlace);
  const addShape = useArgusStore((s) => s.addShape);
  const selection = useArgusStore((s) => s.selection);
  const clearSelection = useArgusStore((s) => s.clearSelection);
  const setDetailOpen = useArgusStore((s) => s.setDetailOpen);
  const ref = useRef<HTMLDivElement>(null);
  const [focusing, setFocusing] = useState(false);
  const [data, setData] = useState<PlaceData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const layers = useArgusStore((s) => s.layers);

  // auto-written intel brief over whatever is rendered right now (recomputes
  // as layer counts land — the template is cheap)
  const brief = useMemo(() => {
    if (!selection.length) return null;
    const map = (window as unknown as { argusMap?: Parameters<typeof buildSitrep>[0] }).argusMap;
    if (!map) return null;
    try {
      return briefLine(buildSitrep(map));
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.length, layers]);

  useEffect(() => {
    if (!place) return;
    // reset to loading for the new place before fetching (external-system sync)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("loading");
    setData(null);
    const ctrl = new AbortController();
    const q = new URLSearchParams({ lat: String(place.lat), lon: String(place.lon) });
    if (place.zoom != null) q.set("zoom", place.zoom.toFixed(1));
    if (place.scopeKind) q.set("scope", place.scopeKind);
    if (place.scopeName) q.set("title", place.scopeName);
    fetch(`/api/place?${q}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: PlaceData) => {
        setData(d);
        setState("ready");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState("error");
      });
    return () => ctrl.abort();
  }, [place]);

  useGSAP(
    () => {
      if (place && ref.current) {
        gsap.fromTo(ref.current, { x: -24, opacity: 0 }, { x: 0, opacity: 1, duration: 0.35, ease: "power3.out" });
      }
    },
    { dependencies: [place?.lat, place?.lon], scope: ref },
  );

  if (!place) return null;

  const focusHere = async () => {
    setFocusing(true);
    try {
      // scope-consistent focus: continent/country resolve from bundled data
      let shape = null;
      if (place.scopeKind === "continent" && place.scopeName) {
        const { continentShape } = await import("@/src/geo/resolve");
        shape = await continentShape(place.scopeName, place.scopeName);
      } else if (place.scopeKind === "country" && place.scopeName) {
        const { countryShape } = await import("@/src/geo/resolve");
        shape = await countryShape(place.scopeName);
      }
      if (!shape) shape = await resolvePlace({ lat: place.lat, lon: place.lon, rzoom: place.zoom != null && place.zoom < 9 ? 5 : 10 });
      if (shape) {
        addShape(shape, false);
        const bb = useArgusStore.getState().aoi?.bbox;
        if (bb) layerManager.fitBbox(bb, { pitch: 15 });
      }
    } finally {
      setFocusing(false);
    }
  };
  const askHere = () =>
    window.dispatchEvent(
      new CustomEvent("argus:ask", {
        detail: `What's happening around ${data?.wiki.title ?? `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}`}?`,
      }),
    );

  return (
    <div ref={ref} className="panel pointer-events-auto w-80 overflow-hidden">
      <div className="flex items-start justify-between px-4 pb-2 pt-3.5">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-[var(--color-text)]">
            {data?.wiki.title ?? place.scopeName ?? (state === "loading" ? "Locating…" : "Place")}
          </div>
          <div className="label mt-0.5 tnum">
            {place.lat.toFixed(4)}, {place.lon.toFixed(4)}
          </div>
        </div>
        <button
          onClick={() => setPlace(null)}
          className="ml-2 text-[var(--color-faint)] transition-colors hover:text-[var(--color-text)]"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="h-[2px] bg-[var(--color-accent)]" />

      {state === "loading" && (
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="argus-spinner" />
          <span className="text-[12px] text-[var(--color-muted)]">gathering intel…</span>
        </div>
      )}
      {state === "error" && (
        <div className="px-4 py-4 text-[12px] text-[var(--color-alert)]">Couldn&apos;t reach place sources.</div>
      )}

      {/* actions — always available. Right-click already focused, so the
          primary action flips to Unfocus while a selection exists. */}
      <div className="grid grid-cols-2 gap-1 border-t border-[var(--color-hairline)] px-3 py-2">
        {selection.length > 0 ? (
          <ActBtn onClick={() => clearSelection()}>◌ Unfocus</ActBtn>
        ) : (
          <ActBtn onClick={() => void focusHere()} busy={focusing}>◎ Focus</ActBtn>
        )}
        <ActBtn onClick={askHere}>✦ Ask Argus</ActBtn>
      </div>

      {/* auto intel brief for the focused area */}
      {brief && (
        <div className="border-t border-[var(--color-hairline)] px-4 py-2.5">
          <span className="label" style={{ color: "var(--color-accent)" }}>Intel brief</span>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text)]">{brief}</p>
        </div>
      )}

      {state === "ready" && data && (
        <div className="flex flex-col gap-3 px-4 py-3">
          {data.wiki.thumb && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.wiki.thumb} alt={data.wiki.title ?? "place"} className="max-h-40 w-full rounded-md object-cover" />
          )}
          {data.address && (
            <div className="text-[11px] leading-relaxed text-[var(--color-muted)]">{data.address}</div>
          )}
          {data.wiki.extract && (
            <div className="text-[12px] leading-relaxed text-[var(--color-text)]">
              {data.wiki.extract.length > 320 ? data.wiki.extract.slice(0, 320) + "…" : data.wiki.extract}
            </div>
          )}
          {data.weather.temp != null && (
            <div className="flex justify-between border-t border-[var(--color-hairline)] pt-2">
              <span className="label">Weather now</span>
              <span className="tnum text-[12px] text-[var(--color-muted)]">
                {data.weather.temp}°C · {data.weather.desc} · {data.weather.wind} km/h
              </span>
            </div>
          )}
          <button
            onClick={() => setDetailOpen(true)}
            className="rounded-md border border-[var(--color-accent)] py-2 text-center text-[11px] uppercase tracking-widest text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
          >
            View more
          </button>
          {!data.wiki.title && !data.address && (
            <div className="text-[12px] text-[var(--color-faint)]">No place record here — open ocean or remote area.</div>
          )}
        </div>
      )}
    </div>
  );
}

function ActBtn({ children, onClick, busy }: { children: React.ReactNode; onClick: () => void; busy?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center gap-1 rounded border border-[var(--color-hairline-strong)] py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      {busy ? <span className="argus-spinner h-3 w-3" /> : children}
    </button>
  );
}
