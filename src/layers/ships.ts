import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { type Bbox, bufferBbox, clampBbox } from "@/src/core/bbox";
import { attachEntityInteractions, pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";
import { currentAoiClip, inClip, destMatchesCountry } from "@/src/core/aoiClip";
import { scopeTooBig } from "@/src/core/tiles";

// vessels sit offshore, so "in this country's waters" needs a generous coastal
// halo around the land polygon (approximates territorial/near waters w/o EEZ data).
// ponytail: fixed halo; swap for a selected EEZ shape when one is picked.
const COAST_MARGIN_DEG = 1.5;

// Live vessels from AISStream (maritime AIS). Streamed via the /api/ais SSE
// bridge (browsers can't reach the AIS WebSocket directly). Positions are
// dead-reckoned along each vessel's course between updates, exactly like the
// aircraft layer, so ships glide instead of teleporting. Needs a free key
// (NEXT_PUBLIC_AISSTREAM_KEY); with none, the layer stays dormant.
const COLOR = "#2dd4bf";
const SRC = "ships-src";
const SYM = "ships-sym";
const ICON = "argus-ship";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const FLUSH_MS = 120;
const KEY = process.env.NEXT_PUBLIC_AISSTREAM_KEY;

export const shipsEnabled = (): boolean => !!KEY;

interface Vessel {
  mmsi: number; // stable id — for agent select/track across frames
  lng: number;
  lat: number;
  cog: number; // course over ground (deg)
  heading: number; // true heading, or cog when unavailable
  sog: number; // knots
  name: string;
  type?: number;
  dest?: string;
  seen: number;
}

const fleet = new Map<number, Vessel>();
let mapRef: MlMap | null = null;
let es: EventSource | null = null;
let rafId: number | null = null;
let lastFrame = 0;
let lastFlush = 0;
// bbox we're currently subscribed to (buffered) — used to avoid tearing down
// and reopening the AIS stream on every small pan within the same area.
let subscribedBbox: Bbox | null = null;

const contains = (outer: Bbox, inner: Bbox): boolean =>
  inner.west >= outer.west &&
  inner.east <= outer.east &&
  inner.south >= outer.south &&
  inner.north <= outer.north;

/** AIS ship-type code → readable category (for the entity panel). */
function shipCategory(type?: number): string {
  if (type == null) return "Vessel";
  if (type === 30) return "Fishing";
  if (type >= 31 && type <= 32) return "Towing";
  if (type === 36) return "Sailing";
  if (type === 37) return "Pleasure craft";
  if (type >= 40 && type <= 49) return "High-speed craft";
  if (type === 50) return "Pilot";
  if (type === 51) return "Search & rescue";
  if (type === 52) return "Tug";
  if (type >= 60 && type <= 69) return "Passenger";
  if (type >= 70 && type <= 79) return "Cargo";
  if (type >= 80 && type <= 89) return "Tanker";
  return "Vessel";
}

function makeIcon(): ImageData {
  const s = 22;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d")!;
  ctx.translate(s / 2, s / 2);
  // simple hull: pointed bow, square stern
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(4, 2);
  ctx.lineTo(3.5, 8);
  ctx.lineTo(-3.5, 8);
  ctx.lineTo(-4, 2);
  ctx.closePath();
  ctx.fillStyle = "#9df5e6";
  ctx.fill();
  ctx.strokeStyle = COLOR;
  ctx.lineWidth = 1;
  ctx.stroke();
  return ctx.getImageData(0, 0, s, s);
}

function flush() {
  if (!mapRef) return;
  // With a region selected, keep only vessels RELATED to it: in its waters
  // (shape + coastal halo) OR declaring a destination in that country. With no
  // selection (open-water browsing) the clip is null → show everything in view.
  const clip = currentAoiClip(COAST_MARGIN_DEG);
  const source = clip
    ? [...fleet.values()].filter((v) => inClip(v.lng, v.lat, clip) || destMatchesCountry(v.dest ?? "", clip))
    : [...fleet.values()];
  const arr = source.slice(0, ships.maxFeatures);
  (mapRef.getSource(SRC) as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: arr.map((v) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [v.lng, v.lat] },
      properties: {
        id: v.mmsi,
        name: v.name || "Vessel",
        cat: shipCategory(v.type),
        sog: v.sog,
        cog: v.cog,
        heading: v.heading,
        dest: v.dest ?? "",
      },
    })),
  });
  useArgusStore.getState().setLayerRuntime("ships", { count: arr.length });
}

// dead-reckoning: advance each vessel along its course between updates
function frame(ts: number) {
  if (!lastFrame) lastFrame = ts;
  const dt = (ts - lastFrame) / 1000;
  lastFrame = ts;
  for (const v of fleet.values()) {
    if (v.sog > 0.2) {
      const meters = v.sog * 0.514444 * dt; // kn → m/s → m
      const tr = (v.cog * Math.PI) / 180;
      v.lat += (meters * Math.cos(tr)) / 111_320;
      v.lng += (meters * Math.sin(tr)) / (111_320 * Math.cos((v.lat * Math.PI) / 180));
    }
  }
  if (ts - lastFlush > FLUSH_MS) {
    lastFlush = ts;
    flush();
  }
  rafId = requestAnimationFrame(frame);
}

function startStream(bbox: Bbox) {
  stopStream();
  const b = clampBbox(bbox);
  const store = useArgusStore.getState();
  es = new EventSource(
    `/api/ais?west=${b.west}&south=${b.south}&east=${b.east}&north=${b.north}`,
  );
  es.onmessage = (e) => {
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data && typeof data === "object" && "ping" in data) return;
    if (data && typeof data === "object" && "error" in data) {
      store.setLayerRuntime("ships", { status: "down", note: String((data as { error: string }).error) });
      return;
    }
    if (!Array.isArray(data)) return;
    const now = Date.now();
    for (const s of data as Array<Record<string, number | string>>) {
      const mmsi = Number(s.mmsi);
      if (!mmsi || typeof s.lat !== "number" || typeof s.lon !== "number") continue;
      fleet.set(mmsi, {
        mmsi,
        lng: s.lon as number,
        lat: s.lat as number,
        cog: Number(s.cog ?? 0),
        heading: Number(s.heading ?? s.cog ?? 0),
        sog: Number(s.sog ?? 0),
        name: String(s.name ?? ""),
        type: s.type != null ? Number(s.type) : undefined,
        dest: s.dest != null ? String(s.dest) : undefined,
        seen: now,
      });
    }
    // prune vessels unseen for >3min (AIS reports slow when anchored)
    for (const [k, v] of fleet) if (now - v.seen > 180_000) fleet.delete(k);
    store.setLayerRuntime("ships", { status: "live", updatedAt: now, note: "AISStream" });
  };
  es.onerror = () => {
    // EventSource auto-reconnects; surface the gap but don't tear down.
    useArgusStore.getState().setLayerRuntime("ships", { status: "down" });
  };
  if (rafId == null) {
    lastFrame = 0;
    lastFlush = 0;
    rafId = requestAnimationFrame(frame);
  }
}

// Visual filter on the rendered vessels: min speed + category (from shipCategory).
function applyFilter() {
  if (!mapRef?.getLayer(SYM)) return;
  const { category, minSpeed } = useArgusStore.getState().filters.ships;
  const parts: unknown[] = ["all", [">=", ["coalesce", ["get", "sog"], 0], minSpeed]];
  if (category && category.toLowerCase() !== "all") parts.push(["==", ["get", "cat"], category]);
  mapRef.setFilter(SYM, parts as unknown as import("maplibre-gl").FilterSpecification);
}

function stopStream() {
  if (es) {
    es.close();
    es = null;
  }
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  subscribedBbox = null;
  fleet.clear();
  (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
}

export const ships: LayerModule = {
  id: "ships",
  label: "Ships",
  color: COLOR,
  group: "movement",
  minZoom: 4,
  maxFeatures: 3000,
  defaultEnabled: false, // lazy: streams only when toggled on
  // maritime: works over open water without picking an AOI first — zoom into
  // any sea past minZoom and vessels stream for the current view.
  viewportFallback: true,

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
        "icon-rotate": ["coalesce", ["get", "heading"], ["get", "cog"], 0],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-size": 0.7,
      },
    });

    attachEntityInteractions(map, SYM, this.id, (f) => {
      const p = f.properties ?? {};
      return {
        title: String(p.name || "Vessel"),
        subtitle: `AIS · ${p.cat ?? "vessel"}`,
        color: COLOR,
        center: pointCenter(f),
        rows: [
          ["Type", String(p.cat ?? "—")],
          ["Speed", p.sog != null ? `${Number(p.sog).toFixed(1)} kn` : "—"],
          ["Course", `${Math.round(Number(p.cog ?? 0))}°`],
          ["Destination", String(p.dest || "—")],
        ] as [string, string][],
      };
    });
  },

  async update(vp: Viewport, load: boolean) {
    if (!load) {
      stopStream();
      useArgusStore.getState().setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    if (!KEY) {
      // registered but dormant without a key — tell the user why, once.
      useArgusStore.getState().setLayerRuntime(this.id, { count: 0, status: "down", note: "needs AISStream key" });
      return;
    }
    applyFilter(); // re-apply on every refresh (LayerManager refreshes on filter change)
    // AOI if the user picked one, else the current viewport (maritime fallback).
    const aoi = useArgusStore.getState().aoi;
    const raw = aoi ? aoi.bbox : vp.bbox;
    // Refuse an area too big to be a digestible vessel view (continent/ocean, or
    // zoomed-way-out) — same threshold as aircraft. Guide to a smaller scope.
    if (scopeTooBig(raw)) {
      stopStream();
      useArgusStore.getState().setLayerRuntime(this.id, {
        count: 0,
        status: "idle",
        note: aoi ? "Region too big — pick a country, state, or city" : "Zoom in to load vessels",
      });
      return;
    }
    // keep the open stream if the new view is still inside what we subscribed to
    if (es && subscribedBbox && contains(subscribedBbox, raw)) return;
    const buffered = bufferBbox(raw);
    startStream(buffered); // resets subscribedBbox via stopStream…
    subscribedBbox = buffered; // …so set it after
  },

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
