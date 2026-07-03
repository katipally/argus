import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { attachEntityInteractions, pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";

// Aurora oval + Kp index (NOAA SWPC). A soft green glow field over the polar
// regions — inherently global, so it loads for the current viewport whenever
// enabled (viewportFallback) instead of waiting for an AOI.
const COLOR = "#57f2a9";
const SRC = "spacewx-src";
const GLOW = "spacewx-glow";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection & { kp?: number | null }>(10 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection & { kp?: number | null }>({ name: "spacewx", cooldownMs: 180_000 });
const guarded = createGuardedFetch(cache, breaker);

let mapRef: MlMap | null = null;
let lastKp: number | null = null;

async function fetchSpaceWx(): Promise<FeatureCollection & { kp?: number | null }> {
  const res = await fetch("/api/spacewx");
  if (!res.ok) throw new Error(`spacewx ${res.status}`);
  return (await res.json()) as FeatureCollection & { kp?: number | null };
}

export const spacewx: LayerModule = {
  id: "spacewx",
  label: "Aurora / space wx",
  color: COLOR,
  group: "sky",
  minZoom: 0,
  maxFeatures: 4000,
  defaultEnabled: false,
  viewportFallback: true,

  init(map) {
    mapRef = map;
    map.addSource(SRC, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: GLOW,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 6, 4, 18, 8, 40],
        "circle-color": [
          "interpolate", ["linear"], ["get", "p"],
          10, "#1f5d43", 30, "#2fae72", 60, "#57f2a9", 90, "#c0ffe3",
        ] as unknown as string,
        "circle-opacity": ["interpolate", ["linear"], ["get", "p"], 10, 0.10, 50, 0.28, 90, 0.42],
        "circle-blur": 1,
      },
    });
    attachEntityInteractions(map, GLOW, this.id, (f) => {
      const p = f.properties ?? {};
      return {
        title: `Aurora probability ${p.p}%`,
        subtitle: "NOAA SWPC · OVATION",
        color: COLOR,
        center: pointCenter(f),
        rows: [
          ["Kp index", lastKp != null ? String(lastKp) : "—"],
          ["Activity", lastKp == null ? "—" : lastKp >= 5 ? `storm G${Math.min(5, Math.floor(lastKp) - 4)}` : "quiet"],
        ] as [string, string][],
      };
    });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    if (!load || !mapRef) {
      (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("spacewx", fetchSpaceWx, EMPTY);
    lastKp = value.kp ?? null;
    (mapRef.getSource(SRC) as GeoJSONSource | undefined)?.setData(value);
    store.setLayerRuntime(this.id, { count: value.features.length, status, updatedAt: Date.now() });
  },

  setVisible(visible) {
    if (mapRef?.getLayer(GLOW)) mapRef.setLayoutProperty(GLOW, "visibility", visible ? "visible" : "none");
  },

  destroy() {
    if (mapRef) {
      if (mapRef.getLayer(GLOW)) mapRef.removeLayer(GLOW);
      if (mapRef.getSource(SRC)) mapRef.removeSource(SRC);
    }
    mapRef = null;
  },
};
