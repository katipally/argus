import type { MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { type Bbox, bboxKey, bufferBbox, clampBbox } from "@/src/core/bbox";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { createHotspotRender, type HotspotRender } from "@/src/core/aggregate";
import { argusFeature, type ArgusFeature } from "@/src/core/feature";
import { pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";

// NASA FIRMS active fires (VIIRS) — keyless via the public global 24h CSV,
// upgraded automatically to the fresher bbox area API when FIRMS_MAP_KEY is set.
const COLOR = "#ff5a2c";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(30 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "fires", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchFirms(bbox: Bbox): Promise<FeatureCollection> {
  const b = clampBbox(bbox);
  const res = await fetch(`/api/firms?bbox=${b.west},${b.south},${b.east},${b.north}`);
  if (!res.ok) throw new Error(`firms ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

function confSeverity(conf: string): number {
  if (conf === "h" || Number(conf) >= 80) return 4;
  if (conf === "n" || Number(conf) >= 50) return 3;
  return 2;
}

function normalize(fc: FeatureCollection): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    const af = argusFeature(lng, lat, {
      id: `fire-${lng.toFixed(3)},${lat.toFixed(3)}`,
      layerId: "fires",
      title: "Active fire",
      severity: confSeverity(String(p.confidence ?? "")),
      ts: p.ts ? Number(p.ts) : undefined,
      confidence: String(p.confidence ?? ""),
      frp: String(p.frp ?? ""),
    });
    if (af) out.push(af);
  }
  return out.slice(0, fires.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: "Active fire",
    subtitle: "NASA FIRMS · VIIRS",
    color: COLOR,
    center: pointCenter(f),
    rows: [
      ["Confidence", String(p.confidence || "—")],
      ["Radiative power", p.frp ? `${p.frp} MW` : "—"],
    ] as [string, string][],
  };
}

export const fires: LayerModule = {
  id: "fires",
  label: "Wildfires",
  color: COLOR,
  group: "earth",
  minZoom: 0,
  maxFeatures: 3000,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "fires", color: COLOR, describe, heatUntil: 6, clusterMaxZoom: 9 });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const bbox = bufferBbox(aoi.bbox);
    const { value, status } = await guarded(bboxKey(bbox), () => fetchFirms(bbox), EMPTY);
    const feats = normalize(value);
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: (bbox) => fetchFirms(bbox),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
