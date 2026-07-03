import type { MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { bufferBbox, pointInBbox, type Bbox } from "@/src/core/bbox";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { createHotspotRender, type HotspotRender } from "@/src/core/aggregate";
import { argusFeature, type ArgusFeature } from "@/src/core/feature";
import { pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";

// Volcanoes with CURRENT activity — Smithsonian GVP / USGS weekly bulletin
// (keyless). A few dozen worldwide at any time, refreshed weekly.
const COLOR = "#ff5c33";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(60 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "volcanoes", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchVolcanoes(): Promise<FeatureCollection> {
  const res = await fetch("/api/volcanoes");
  if (!res.ok) throw new Error(`volcanoes ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

function normalize(fc: FeatureCollection, bbox: Bbox): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const af = argusFeature(lng, lat, {
      id: `volcano-${p.name}`,
      layerId: "volcanoes",
      title: String(p.name ?? "Volcano"),
      severity: Number(p.severity) || 1,
      status: String(p.status ?? ""),
      country: String(p.country ?? ""),
      period: String(p.period ?? ""),
      url: String(p.url ?? ""),
    });
    if (af) out.push(af);
  }
  return out.slice(0, volcanoes.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: String(p.title ?? "Volcano"),
    subtitle: `GVP · ${String(p.country || "volcano")}`,
    color: COLOR,
    center: pointCenter(f),
    url: String(p.url ?? ""),
    rows: [
      ["Status", String(p.status || "—")],
      ["Report", String(p.period || "—")],
    ] as [string, string][],
  };
}

export const volcanoes: LayerModule = {
  id: "volcanoes",
  label: "Volcanoes",
  color: COLOR,
  group: "earth",
  minZoom: 0,
  maxFeatures: 200,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "volcanoes", color: COLOR, describe, heatUntil: 3, clusterMaxZoom: 4 });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("volcanoes", fetchVolcanoes, EMPTY);
    const feats = normalize(value, bufferBbox(aoi.bbox));
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: () => fetchVolcanoes(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
