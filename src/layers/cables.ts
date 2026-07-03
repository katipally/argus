import type { Map as MlMap, MapGeoJSONFeature } from "maplibre-gl";
import type { Feature, FeatureCollection, Position } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { attachEntityInteractions, pointCenter } from "./interactions";
import { currentAoiClip, inClip, type AoiClip } from "@/src/core/aoiClip";
import { useArgusStore } from "@/src/store/useArgusStore";

// Submarine cables — the physical internet on the map (TeleGeography, keyless).
// Static infrastructure: fetched once per session, drawn as lines in each
// cable's own brand color. Opt-in toggle; works at any zoom, no AOI needed.

const COLOR = "#2dd4bf";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const SRC = "cables-src";
const LINE = "cables-line";

let mapRef: MlMap | null = null;
let data: FeatureCollection | null = null; // session cache — cables don't move
let loading = false;

async function fetchCables(): Promise<FeatureCollection> {
  const res = await fetch("/api/cables");
  if (!res.ok) throw new Error(`cables ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

/** Does the cable touch the region's REAL shape (sampled vertices + endpoints)? */
function cableTouches(f: Feature, clip: AoiClip): boolean {
  const g = f.geometry;
  const lines: Position[][] =
    g.type === "MultiLineString" ? g.coordinates : g.type === "LineString" ? [g.coordinates] : [];
  for (const line of lines) {
    if (!line.length) continue;
    // sample ≤40 vertices per segment, but ALWAYS test both ends (landing points)
    const stride = Math.max(1, Math.floor(line.length / 40));
    for (let i = 0; i < line.length; i += stride) {
      if (inClip(line[i][0], line[i][1], clip)) return true;
    }
    const last = line[line.length - 1];
    if (inClip(last[0], last[1], clip)) return true;
  }
  return false;
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  // the feed carries a label point per cable — better anchor than a bbox center
  let center = pointCenter(f);
  try {
    const c = typeof p.coordinates === "string" ? (JSON.parse(p.coordinates) as number[]) : (p.coordinates as number[]);
    if (Array.isArray(c) && c.length === 2) center = [c[0], c[1]];
  } catch { /* fall back to geometry center */ }
  return {
    title: String(p.name ?? "Submarine cable"),
    subtitle: "submarine cable · TeleGeography",
    color: String(p.color ?? COLOR),
    center,
    rows: [] as [string, string][],
  };
}

export const cables: LayerModule = {
  id: "cables",
  label: "Submarine cables",
  color: COLOR,
  group: "ground",
  minZoom: 0,
  maxFeatures: 1000,
  defaultEnabled: false,

  init(map) {
    mapRef = map;
    map.addSource(SRC, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["coalesce", ["get", "color"], COLOR],
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.7, 6, 1.6, 10, 2.6],
        "line-opacity": 0.6,
      },
    });
    attachEntityInteractions(map, LINE, "cables", describe);
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    // coastal halo like ships — cables land on shores and run offshore
    const clip = currentAoiClip(1.5);
    const src = mapRef?.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (!load || !clip) {
      src?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    if (!data && !loading) {
      loading = true;
      try {
        data = await fetchCables();
      } catch {
        store.setLayerRuntime(this.id, { count: 0, status: "down" });
        return;
      } finally {
        loading = false;
      }
    }
    if (!data) return;
    // only cables touching the focused region's shape — same clean-view rule as every layer
    const feats = data.features.filter((f) => cableTouches(f, clip));
    src?.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, {
      count: feats.length,
      status: "live",
      updatedAt: Date.now(),
      note: "TeleGeography",
    });
  },

  query: () => fetchCables(),

  setVisible(visible) {
    if (mapRef?.getLayer(LINE)) mapRef.setLayoutProperty(LINE, "visibility", visible ? "visible" : "none");
  },

  destroy() {
    if (mapRef?.getLayer(LINE)) mapRef.removeLayer(LINE);
    if (mapRef?.getSource(SRC)) mapRef.removeSource(SRC);
    mapRef = null;
  },
};
