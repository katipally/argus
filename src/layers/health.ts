import type { MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { createHotspotRender, type HotspotRender } from "@/src/core/aggregate";
import { argusFeature, type ArgusFeature } from "@/src/core/feature";
import { pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";

// WHO disease-outbreak emergencies (keyless). A handful worldwide at a time, so
// unlike the AOI-gated geophysical layers this one renders GLOBALLY — every
// active outbreak shows at world zoom, no region focus needed (viewportFallback
// + minZoom 0 keeps it active whenever enabled).
const COLOR = "#c084fc";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(60 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "health", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchWho(): Promise<FeatureCollection> {
  const res = await fetch("/api/who");
  if (!res.ok) throw new Error(`who ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

function normalize(fc: FeatureCollection): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    const af = argusFeature(lng, lat, {
      id: `who-${p.disease}-${p.country}`,
      layerId: "health",
      title: String(p.disease ?? "Outbreak"),
      severity: Number(p.severity) || 1,
      country: String(p.country ?? ""),
      date: String(p.date ?? ""),
      url: String(p.url ?? ""),
    });
    if (af) out.push(af);
  }
  return out.slice(0, health.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: String(p.title ?? "Outbreak"),
    subtitle: `WHO · ${String(p.country || "outbreak")}`,
    color: COLOR,
    center: pointCenter(f),
    url: String(p.url ?? ""),
    rows: [
      ["Location", String(p.country || "—")],
      ["Reported", String(p.date || "—")],
    ] as [string, string][],
  };
}

export const health: LayerModule = {
  id: "health",
  label: "Disease outbreaks",
  color: COLOR,
  group: "signals",
  minZoom: 0,
  maxFeatures: 200,
  defaultEnabled: false,
  viewportFallback: true, // global overview — active without picking an AOI

  init(map) {
    render = createHotspotRender(map, { id: "health", color: COLOR, describe, heatUntil: 3, clusterMaxZoom: 3 });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    if (!load || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("who", fetchWho, EMPTY);
    const feats = normalize(value);
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now(), note: "WHO" });
  },

  query: () => fetchWho(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
