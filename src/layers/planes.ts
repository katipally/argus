import type { Map as MlMap, GeoJSONSource, FilterSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { type Bbox, bufferBbox, primaryBbox, unionBbox } from "@/src/core/bbox";
import { coverageTiles } from "@/src/core/tiles";
import { attachEntityInteractions, pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";
import { currentAoiClip, inClip, airportInClip } from "@/src/core/aoiClip";

const TOO_BIG_NOTE = "Region too big — pick a country, state, or city";

// halo around the selected shape counted as "in this country's airspace".
const AIRSPACE_MARGIN_DEG = 0.6;

const COLOR = "#ffb020";
const SRC = "planes-src";
const SYM = "planes-sym";
const ICON = "argus-plane";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const POLL_MS = 12_000; // refresh authoritative positions
const FLUSH_MS = 90; // ~11fps setData while interpolating

interface Airport {
  c: string; // ISO2 country
  lat: number;
  lon: number;
}

interface AC {
  hex: string; // stable id (ICAO hex) — for agent select/track across frames
  lng: number;
  lat: number;
  track: number;
  gs: number; // knots
  alt: number | null;
  flight: string;
  craft: string;
  mil: number;
  seen: number; // last-seen timestamp (ms) for grace-period pruning
  o?: Airport; // origin airport (route enrichment)
  d?: Airport; // destination airport
  routed?: boolean; // route lookup returned an answer (don't re-ask)
}

const fleet = new Map<string, AC>();
let mapRef: MlMap | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let rafId: number | null = null;
let lastFrame = 0;
let lastFlush = 0;
let query: Bbox | null = null;

/** Coverage bbox = union of each selected shape's MAINLAND bbox (so France's
 *  overseas territories don't blow the scope up to "too big"), lightly buffered. */
function coverageBbox(): Bbox | null {
  const sel = useArgusStore.getState().selection;
  let bb: Bbox | null = null;
  for (const s of sel) {
    const pb = primaryBbox(s.geometry);
    if (pb) bb = bb ? unionBbox(bb, pb) : pb;
  }
  return bb ? bufferBbox(bb, 0.1) : null;
}

function makeIcon(): ImageData {
  const s = 24;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d")!;
  ctx.translate(s / 2, s / 2);
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(6, 8);
  ctx.lineTo(0, 4);
  ctx.lineTo(-6, 8);
  ctx.closePath();
  ctx.fillStyle = "#ffd98a";
  ctx.fill();
  ctx.strokeStyle = COLOR;
  ctx.lineWidth = 1;
  ctx.stroke();
  return ctx.getImageData(0, 0, s, s);
}

let lastSources = "";

async function fetchPlanes(b: Bbox): Promise<FeatureCollection> {
  const res = await fetch(`/api/adsb?west=${b.west}&south=${b.south}&east=${b.east}&north=${b.north}`);
  if (!res.ok) throw new Error(`adsb ${res.status}`);
  lastSources = res.headers.get("X-Argus-Sources") ?? "";
  const j = (await res.json()) as FeatureCollection | { tooBig: true };
  // client pre-gates on tile count, so this is defensive: render nothing.
  return "tooBig" in j ? EMPTY : j;
}

function syncFleet(fc: FeatureCollection) {
  const now = Date.now();
  for (const f of fc.features) {
    if (f.geometry.type !== "Point") continue;
    const p = f.properties ?? {};
    const hex = String(p.hex ?? p.flight ?? Math.random());
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const cur = fleet.get(hex);
    const next: AC = {
      hex,
      lng,
      lat,
      track: Number(p.track ?? 0),
      gs: Number(p.gs ?? 0),
      alt: p.alt ?? null,
      flight: String(p.flight ?? hex),
      craft: String(p.craft ?? ""),
      mil: Number(p.mil ?? 0),
      seen: now,
    };
    fleet.set(hex, cur ? { ...cur, ...next } : next);
  }
  // prune only aircraft unseen for >25s — a single flaky poll won't wipe them
  for (const [k, ac] of fleet) if (now - ac.seen > 25_000) fleet.delete(k);
}

// Enrich fleet aircraft with origin/dest airports (callsign → route → country)
// so we can keep flights RELATED to the selected country, not just those over
// it. Best-effort + heavily cached server-side; unresolved callsigns get re-asked
// cheaply next poll. One in-flight request at a time.
let enriching = false;
async function enrichRoutes() {
  if (enriching) return;
  const want = new Set<string>();
  for (const ac of fleet.values()) {
    if (!ac.routed && ac.flight) want.add(ac.flight.toUpperCase());
  }
  const list = [...want].slice(0, 150); // cap URL length; rest fill next poll
  if (!list.length) return;
  enriching = true;
  try {
    const res = await fetch(`/api/adsb/routes?callsigns=${encodeURIComponent(list.join(","))}`);
    if (!res.ok) return;
    const { routes } = (await res.json()) as { routes: Record<string, { o?: Airport; d?: Airport }> };
    for (const ac of fleet.values()) {
      const r = routes[ac.flight?.toUpperCase()];
      if (!r) continue; // deferred by the server — ask again next poll
      ac.o = r.o;
      ac.d = r.d;
      ac.routed = true;
    }
  } catch {
    /* transient — retry next poll */
  } finally {
    enriching = false;
  }
}

// An aircraft is shown only if it's RELATED to the selection: physically in the
// country's airspace, OR its origin/dest airport is inside the country.
function related(ac: AC, clip: ReturnType<typeof currentAoiClip>): boolean {
  if (!clip) return true; // no region focus → show everything (shouldn't happen; planes need an AOI)
  if (inClip(ac.lng, ac.lat, clip)) return true;
  if (ac.o && airportInClip(ac.o.lon, ac.o.lat, clip)) return true;
  if (ac.d && airportInClip(ac.d.lon, ac.d.lat, clip)) return true;
  return false;
}

function flush() {
  if (!mapRef) return;
  const clip = currentAoiClip(AIRSPACE_MARGIN_DEG);
  const arr = [...fleet.values()].filter((ac) => related(ac, clip)).slice(0, planes.maxFeatures);
  (mapRef.getSource(SRC) as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: arr.map((ac) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [ac.lng, ac.lat] },
      properties: {
        id: ac.hex,
        flight: ac.flight,
        craft: ac.craft,
        alt: ac.alt,
        gs: ac.gs,
        track: ac.track,
        mil: ac.mil,
        from: ac.o?.c ?? "",
        to: ac.d?.c ?? "",
      },
    })),
  });
  useArgusStore.getState().setLayerRuntime("planes", { count: arr.length });
}

// dead-reckoning: advance each aircraft along its track between polls
function frame(ts: number) {
  if (!lastFrame) lastFrame = ts;
  const dt = (ts - lastFrame) / 1000;
  lastFrame = ts;
  for (const ac of fleet.values()) {
    if (ac.gs > 0) {
      const meters = ac.gs * 0.514444 * dt; // kn → m/s → m
      const tr = (ac.track * Math.PI) / 180;
      ac.lat += (meters * Math.cos(tr)) / 111_320;
      ac.lng += (meters * Math.sin(tr)) / (111_320 * Math.cos((ac.lat * Math.PI) / 180));
    }
  }
  if (ts - lastFlush > FLUSH_MS) {
    lastFlush = ts;
    flush();
  }
  rafId = requestAnimationFrame(frame);
}

async function doPoll() {
  if (!query) return;
  // hidden tab: skip the fetch (rAF is already throttled by the browser);
  // the fleet's 25s grace keeps aircraft alive across a brief tab switch
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  try {
    const fc = await fetchPlanes(query);
    syncFleet(fc);
    void enrichRoutes(); // fire-and-forget route enrichment for the related filter
    const n = lastSources ? lastSources.split(",").length : 0;
    useArgusStore.getState().setLayerRuntime("planes", {
      status: "live",
      updatedAt: Date.now(),
      note: n ? `${n} source${n > 1 ? "s" : ""}` : undefined,
    });
  } catch {
    useArgusStore.getState().setLayerRuntime("planes", { status: "down" });
  }
}

function startStream(b: Bbox) {
  query = b;
  if (!pollTimer) {
    void doPoll();
    pollTimer = setInterval(doPoll, POLL_MS);
  }
  if (rafId == null) {
    lastFrame = 0;
    lastFlush = 0;
    rafId = requestAnimationFrame(frame);
  }
}

function stopStream() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  query = null;
  fleet.clear();
  (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
}

function applyFilter() {
  if (!mapRef?.getLayer(SYM)) return;
  const { minAlt, maxAlt, category } = useArgusStore.getState().filters.planes;
  const parts: unknown[] = [
    "all",
    [">=", ["coalesce", ["get", "alt"], 0], minAlt],
    ["<=", ["coalesce", ["get", "alt"], 0], maxAlt],
  ];
  if (category === "mil") parts.push(["==", ["get", "mil"], 1]);
  if (category === "civ") parts.push(["==", ["get", "mil"], 0]);
  mapRef.setFilter(SYM, parts as unknown as FilterSpecification);
}

export const planes: LayerModule = {
  id: "planes",
  label: "Aircraft",
  color: COLOR,
  group: "movement",
  minZoom: 4,
  maxFeatures: 2000,
  defaultEnabled: false, // lazy: streams only when the user toggles it on

  init(map) {
    mapRef = map;
    if (!map.hasImage(ICON)) map.addImage(ICON, makeIcon(), { pixelRatio: 2 });
    map.addSource(SRC, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: SYM,
      type: "symbol",
      source: SRC,
      layout: {
        "icon-image": ICON,
        "icon-rotate": ["coalesce", ["get", "track"], 0],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-size": 0.75,
      },
    });

    attachEntityInteractions(map, SYM, this.id, (f) => {
      const p = f.properties ?? {};
      return {
        title: String(p.flight ?? "Aircraft"),
        subtitle: `ADS-B · live${Number(p.mil) ? " · MIL" : ""}`,
        color: COLOR,
        center: pointCenter(f),
        rows: [
          ["Type", String(p.craft || "—")],
          ["Route", p.from || p.to ? `${p.from || "?"} → ${p.to || "?"}` : "—"],
          ["Altitude", p.alt != null ? `${Number(p.alt).toLocaleString()} ft` : "—"],
          ["Ground spd", p.gs != null ? `${Math.round(Number(p.gs))} kt` : "—"],
          ["Track", `${Math.round(Number(p.track ?? 0))}°`],
        ] as [string, string][],
      };
    });
  },

  async update(_vp: Viewport, load: boolean) {
    const aoi = useArgusStore.getState().aoi;
    if (!load || !aoi) {
      stopStream();
      useArgusStore.getState().setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    // Refuse scopes too large to fetch as digestible live data (continents,
    // huge countries) — tell the user to pick something smaller instead of
    // dumping a sparse, mis-covered blob.
    const cov = coverageBbox();
    if (!cov || coverageTiles(cov) === null) {
      stopStream();
      useArgusStore.getState().setLayerRuntime(this.id, { count: 0, status: "idle", note: TOO_BIG_NOTE });
      return;
    }
    startStream(cov);
    applyFilter();
  },

  query: (bbox) => fetchPlanes(bufferBbox(bbox)),

  setVisible(visible) {
    if (mapRef?.getLayer(SYM)) {
      mapRef.setLayoutProperty(SYM, "visibility", visible ? "visible" : "none");
    }
  },

  destroy() {
    stopStream();
    if (!mapRef) return;
    if (mapRef.getLayer(SYM)) mapRef.removeLayer(SYM);
    if (mapRef.getSource(SRC)) mapRef.removeSource(SRC);
    mapRef = null;
  },
};
