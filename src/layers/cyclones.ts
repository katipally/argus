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

// Active tropical cyclones (NOAA NHC live positions). A handful of storms at
// most — no clustering needed, but the hotspot helper keeps interactions and
// severity styling consistent with the rest of EARTH.
const COLOR = "#9d7bff";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(15 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "cyclones", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchCyclones(): Promise<FeatureCollection> {
  const res = await fetch("/api/cyclones");
  if (!res.ok) throw new Error(`cyclones ${res.status}`);
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
      id: `cyclone-${p.name}`,
      layerId: "cyclones",
      title: `${p.class ?? "Storm"} ${p.name ?? ""}`.trim(),
      severity: Number(p.severity) || 2,
      ts: p.ts ? Number(p.ts) : undefined,
      windKt: String(p.windKt ?? ""),
      pressure: String(p.pressure ?? ""),
      moving: String(p.moving ?? ""),
      url: String(p.url ?? ""),
    });
    if (af) out.push(af);
  }
  return out;
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: String(p.title ?? "Storm"),
    subtitle: "NOAA NHC · live",
    color: COLOR,
    center: pointCenter(f),
    url: String(p.url ?? ""),
    rows: [
      ["Winds", p.windKt ? `${p.windKt} kt` : "—"],
      ["Pressure", p.pressure ? `${p.pressure} mb` : "—"],
      ["Motion", String(p.moving || "—")],
    ] as [string, string][],
  };
}

export const cyclones: LayerModule = {
  id: "cyclones",
  label: "Cyclones",
  color: COLOR,
  group: "earth",
  minZoom: 0,
  maxFeatures: 50,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "cyclones", color: COLOR, describe, heatUntil: 2, clusterMaxZoom: 3 });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("cyclones", fetchCyclones, EMPTY);
    const feats = normalize(value, bufferBbox(aoi.bbox, 0.5));
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: () => fetchCyclones(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
