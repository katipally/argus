import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { bufferBbox, type Bbox } from "@/src/core/bbox";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { attachEntityInteractions, pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";

// Air quality — Open-Meteo grid samples over the AOI rendered as a soft field of
// graduated circles colored by US AQI (green → maroon, EPA breakpoints).
const COLOR = "#8bd450";
const SRC = "airquality-src";
const DOT = "airquality-dots";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// re-fetch per bbox at most every 30 min (matches the route's edge cache)
const cache = new BboxCache<FeatureCollection>(30 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "airquality", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let mapRef: MlMap | null = null;

const AQI_COLOR = [
  "step", ["get", "aqi"],
  "#4ade80", 51, "#facc15", 101, "#fb923c", 151, "#ef4444", 201, "#a855f7", 301, "#7f1d1d",
] as unknown as string;

function aqiLabel(aqi: number): string {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "unhealthy (sensitive)";
  if (aqi <= 200) return "unhealthy";
  if (aqi <= 300) return "very unhealthy";
  return "hazardous";
}

async function fetchAq(bbox: Bbox): Promise<FeatureCollection> {
  const q = `west=${bbox.west.toFixed(2)}&south=${bbox.south.toFixed(2)}&east=${bbox.east.toFixed(2)}&north=${bbox.north.toFixed(2)}`;
  const res = await fetch(`/api/airquality?${q}`);
  if (!res.ok) throw new Error(`airquality ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

export const airquality: LayerModule = {
  id: "airquality",
  label: "Air quality",
  color: COLOR,
  group: "sky",
  minZoom: 0,
  maxFeatures: 100,
  defaultEnabled: false,

  init(map) {
    mapRef = map;
    map.addSource(SRC, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: DOT,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 10, 8, 26],
        "circle-color": AQI_COLOR,
        "circle-opacity": 0.3,
        "circle-blur": 0.6,
      },
    });
    attachEntityInteractions(map, DOT, this.id, (f) => {
      const p = f.properties ?? {};
      const aqi = Number(p.aqi) || 0;
      return {
        title: `AQI ${aqi} · ${aqiLabel(aqi)}`,
        subtitle: "Open-Meteo · CAMS model",
        color: COLOR,
        center: pointCenter(f),
        rows: [
          ["PM2.5", p.pm25 != null ? `${p.pm25} µg/m³` : "—"],
          ["PM10", p.pm10 != null ? `${p.pm10} µg/m³` : "—"],
          ["Ozone", p.ozone != null ? `${p.ozone} µg/m³` : "—"],
        ] as [string, string][],
      };
    });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !mapRef) {
      (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const bbox = bufferBbox(aoi.bbox, 0.05);
    const { value, status } = await guarded(
      `aq:${bbox.west.toFixed(1)},${bbox.south.toFixed(1)},${bbox.east.toFixed(1)},${bbox.north.toFixed(1)}`,
      () => fetchAq(bbox),
      EMPTY,
    );
    (mapRef.getSource(SRC) as GeoJSONSource | undefined)?.setData(value);
    store.setLayerRuntime(this.id, { count: value.features.length, status, updatedAt: Date.now() });
  },

  setVisible(visible) {
    if (mapRef?.getLayer(DOT)) mapRef.setLayoutProperty(DOT, "visibility", visible ? "visible" : "none");
  },

  destroy() {
    if (mapRef) {
      if (mapRef.getLayer(DOT)) mapRef.removeLayer(DOT);
      if (mapRef.getSource(SRC)) mapRef.removeSource(SRC);
    }
    mapRef = null;
  },
};
