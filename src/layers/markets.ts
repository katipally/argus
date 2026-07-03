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

// World stock indices pinned to their exchanges — live market pulse on the map.

const COLOR = "#5ad8a6";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(2 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "markets", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchMarkets(): Promise<FeatureCollection> {
  const res = await fetch("/api/markets");
  if (!res.ok) throw new Error(`markets ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

/** |day move %| → 0–4 so big swings glow hotter. */
function moveSeverity(pct: number): number {
  const a = Math.abs(pct);
  if (a >= 3) return 4;
  if (a >= 2) return 3;
  if (a >= 1) return 2;
  if (a >= 0.4) return 1;
  return 0;
}

function normalize(fc: FeatureCollection, bbox: ReturnType<typeof bufferBbox>): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const pct = Number(p.changePct) || 0;
    const af = argusFeature(lng, lat, {
      id: String(p.id),
      layerId: "markets",
      title: String(p.name ?? "Index"),
      severity: moveSeverity(pct),
      ts: Number(p.ts) || undefined,
      city: String(p.city ?? ""),
      price: String(p.price ?? ""),
      changePct: String(pct),
      currency: String(p.currency ?? ""),
    });
    if (af) out.push(af);
  }
  return out;
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  const pct = Number(p.changePct) || 0;
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "—";
  return {
    title: String(p.title ?? "Index"),
    subtitle: `${String(p.city ?? "")} · market index`,
    color: COLOR,
    center: pointCenter(f),
    rows: [
      ["Last", `${Number(p.price).toLocaleString()} ${p.currency ?? ""}`],
      ["Day", `${arrow} ${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`],
    ] as [string, string][],
  };
}

export const markets: LayerModule = {
  id: "markets",
  label: "Markets",
  color: COLOR,
  group: "signals",
  minZoom: 0,
  maxFeatures: 50,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "markets", color: COLOR, describe, heatUntil: 0, clusterMaxZoom: 3 });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("markets", fetchMarkets, EMPTY);
    const feats = normalize(value, bufferBbox(aoi.bbox));
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: () => fetchMarkets(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
