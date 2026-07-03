import type { MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { bufferBbox, pointInBbox } from "@/src/core/bbox";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { createHotspotRender, type HotspotRender } from "@/src/core/aggregate";
import { argusFeature, type ArgusFeature } from "@/src/core/feature";
import { pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";

const COLOR = "#ff8a3d";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(10 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "hazards", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchEonet(): Promise<FeatureCollection> {
  const res = await fetch("/api/eonet");
  if (!res.ok) throw new Error(`eonet ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

/** Hazard categories carry no numeric severity; weight the dangerous ones up. */
const CAT_SEV: Record<string, number> = {
  Volcanoes: 3,
  Wildfires: 3,
  "Severe Storms": 3,
  "Sea and Lake Ice": 1,
};

function normalize(
  fc: FeatureCollection,
  bbox: ReturnType<typeof bufferBbox>,
  categories: string[],
): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const category = String(p.category ?? "");
    if (categories.length && !categories.includes(category)) continue;
    const af = argusFeature(lng, lat, {
      id: String(p.id ?? `${lng},${lat}`),
      layerId: "hazards",
      title: String(p.title ?? "Natural event"),
      severity: CAT_SEV[category] ?? 2,
      ts: p.date ? Date.parse(String(p.date)) || undefined : undefined,
      category,
      date: String(p.date ?? "").slice(0, 10),
      mag: p.mag != null ? String(p.mag) : "",
    });
    if (af) out.push(af);
  }
  return out.slice(0, hazards.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: String(p.title ?? "Natural event"),
    subtitle: `NASA EONET · ${String(p.category ?? "")}`,
    color: COLOR,
    center: pointCenter(f),
    rows: [
      ["Category", String(p.category || "—")],
      ["Date", String(p.date || "—")],
      ...(p.mag ? ([["Magnitude", String(p.mag)]] as [string, string][]) : []),
    ] as [string, string][],
  };
}

export const hazards: LayerModule = {
  id: "hazards",
  label: "Natural hazards",
  color: COLOR,
  group: "earth",
  minZoom: 0,
  maxFeatures: 800,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "hazards", color: COLOR, describe });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("eonet", fetchEonet, EMPTY);
    const feats = normalize(value, bufferBbox(aoi.bbox), store.filters.hazards.categories);
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: () => fetchEonet(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
