import type { Map as MlMap, GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection, Point } from "geojson";
import type * as SatLib from "satellite.js";
import type { LayerModule, Viewport } from "./types";
import { useArgusStore } from "@/src/store/useArgusStore";

const COLOR = "#8affc1";
const SRC = "space-src";
const DOT = "space-dot";
const LABEL = "space-label";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

interface Sat {
  name: string;
  satrec: SatLib.SatRec;
  iss: boolean;
}

let mapRef: MlMap | null = null;
let sats: Sat[] = [];
let raf: number | null = null;
let fetchedAt = 0;
let visible = false;
// satellite.js is a large CJS lib — load it lazily (only when the Space layer is
// used) so it never sits in the initial bundle. Cached after first load.
let satlib: typeof SatLib | null = null;

async function loadTles(): Promise<Sat[]> {
  if (!satlib) satlib = await import("satellite.js");
  const res = await fetch("/api/tles?group=stations");
  if (!res.ok) throw new Error(`tles ${res.status}`);
  const text = await res.text();
  const lines = text.split("\n").map((l) => l.trimEnd());
  const out: Sat[] = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = (lines[i] ?? "").trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!name || !l1?.startsWith("1 ") || !l2?.startsWith("2 ")) continue;
    try {
      out.push({ name, satrec: satlib.twoline2satrec(l1, l2), iss: /ISS|ZARYA/i.test(name) });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Propagate every satellite to `now` and build the point set. */
function positions(now: Date): Feature<Point>[] {
  if (!satlib) return [];
  const gmst = satlib.gstime(now);
  const feats: Feature<Point>[] = [];
  for (const s of sats) {
    let pv: ReturnType<typeof SatLib.propagate> | null = null;
    try {
      pv = satlib.propagate(s.satrec, now);
    } catch {
      continue;
    }
    if (!pv) continue;
    const pos = pv.position;
    if (!pos || typeof pos === "boolean") continue;
    const geo = satlib.eciToGeodetic(pos, gmst);
    const lon = satlib.degreesLong(geo.longitude);
    const lat = satlib.degreesLat(geo.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const vel = pv.velocity;
    const speed =
      vel && typeof vel !== "boolean"
        ? Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z)
        : 0;
    feats.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        name: s.name,
        iss: s.iss ? 1 : 0,
        altKm: Math.round(geo.height),
        speedKms: speed.toFixed(2),
      },
    });
  }
  return feats;
}

function tick() {
  if (!mapRef || !visible) return;
  const feats = positions(new Date());
  (mapRef.getSource(SRC) as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: feats,
  });
  raf = requestAnimationFrame(tick);
}

export const space: LayerModule = {
  id: "space",
  label: "Satellites",
  color: COLOR,
  group: "movement",
  minZoom: 0,
  maxFeatures: 200,
  defaultEnabled: false,
  // Satellites orbit the whole globe — show them whenever enabled, no AOI needed.
  viewportFallback: true,

  init(map) {
    mapRef = map;
    map.addSource(SRC, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: DOT,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": ["case", ["==", ["get", "iss"], 1], 6, 3.5],
        "circle-color": COLOR,
        "circle-stroke-color": "#02040a",
        "circle-stroke-width": 1.4,
        "circle-opacity": 0.95,
      },
    });
    map.addLayer({
      id: LABEL,
      type: "symbol",
      source: SRC,
      // label the ISS always, others once zoomed in a bit
      filter: ["any", ["==", ["get", "iss"], 1], [">=", ["zoom"], 4]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
      },
      paint: {
        "text-color": COLOR,
        "text-halo-color": "#02040a",
        "text-halo-width": 1.2,
      },
    });

    const describe = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties ?? {};
      useArgusStore.getState().setSelected({
        layerId: "space",
        title: String(p.name ?? "Satellite"),
        subtitle: "CelesTrak · orbital",
        color: COLOR,
        center: [f.geometry.coordinates[0], f.geometry.coordinates[1]],
        rows: [
          ["Altitude", `${p.altKm ?? "—"} km`],
          ["Velocity", `${p.speedKms ?? "—"} km/s`],
        ],
      });
    };
    map.on("click", DOT, describe);
    map.on("mouseenter", DOT, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", DOT, () => (map.getCanvas().style.cursor = ""));
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    if (!load) {
      visible = false;
      if (raf != null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    // (re)load TLEs at most every 6h; propagation itself is free and continuous
    if (sats.length === 0 || Date.now() - fetchedAt > 6 * 3600_000) {
      try {
        sats = await loadTles();
        fetchedAt = Date.now();
      } catch {
        store.setLayerRuntime(this.id, { count: sats.length, status: "down" });
        return;
      }
    }
    visible = true;
    if (raf == null) tick();
    store.setLayerRuntime(this.id, { count: sats.length, status: "live", updatedAt: Date.now() });
  },

  setVisible(v) {
    visible = v && sats.length > 0;
    if (!mapRef) return;
    for (const id of [DOT, LABEL]) {
      if (mapRef.getLayer(id)) mapRef.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    }
    if (v && raf == null && sats.length) tick();
    if (!v && raf != null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  },

  destroy() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    if (mapRef) {
      for (const id of [DOT, LABEL]) if (mapRef.getLayer(id)) mapRef.removeLayer(id);
      if (mapRef.getSource(SRC)) mapRef.removeSource(SRC);
    }
    mapRef = null;
    sats = [];
  },
};
