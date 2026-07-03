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

// Protests / civil unrest, derived from the SAME GDELT Events feed the News and
// Conflict layers share — filtered to CAMEO root code 14 (protest). Zero new
// upstream; one fetch feeds three signal layers.
const COLOR = "#ffd166";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(15 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "unrest", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchGdelt(): Promise<FeatureCollection> {
  const res = await fetch("/api/gdelt");
  if (!res.ok) throw new Error(`gdelt ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

/** Coverage volume → 0–4 (how big/reported the protest is). */
function volumeSeverity(mentions: number): number {
  if (mentions >= 50) return 4;
  if (mentions >= 15) return 3;
  if (mentions >= 5) return 2;
  if (mentions >= 2) return 1;
  return 0;
}

function normalize(fc: FeatureCollection, bbox: Bbox): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    if (String(p.root) !== "14") continue; // CAMEO 14x = protest events only
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const mentions = Number(p.mentions) || 1;
    const af = argusFeature(lng, lat, {
      id: `unrest-${p.id}`,
      layerId: "unrest",
      title: String(p.place ?? "Protest"),
      severity: volumeSeverity(mentions),
      mentions: String(mentions),
      domain: String(p.domain ?? ""),
      url: String(p.url ?? ""),
    });
    if (af) out.push(af);
  }
  return out.slice(0, unrest.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: String(p.title ?? "Protest"),
    subtitle: `GDELT · ${String(p.domain || "unrest")}`,
    color: COLOR,
    center: pointCenter(f),
    url: String(p.url ?? ""),
    rows: [
      ["Coverage", `${p.mentions ?? "—"} mentions`],
      ["Source", String(p.domain || "—")],
    ] as [string, string][],
  };
}

export const unrest: LayerModule = {
  id: "unrest",
  label: "Unrest",
  color: COLOR,
  group: "signals",
  minZoom: 0,
  maxFeatures: 1500,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "unrest", color: COLOR, describe, heatUntil: 6, clusterMaxZoom: 8 });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("gdelt", fetchGdelt, EMPTY);
    const feats = normalize(value, bufferBbox(aoi.bbox));
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: () => fetchGdelt(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
