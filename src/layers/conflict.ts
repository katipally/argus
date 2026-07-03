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

// Conflict events. UCDP now requires an auth token (was keyless), so we derive
// conflict from the SAME GDELT Events feed the News layer uses — filtered to
// material-conflict events (QuadClass 4) with a strongly negative Goldstein
// score. Reuses one upstream fetch; severity scales with conflict intensity.
const COLOR = "#ff2d55";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(15 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "conflict", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchGdelt(): Promise<FeatureCollection> {
  const res = await fetch("/api/gdelt");
  if (!res.ok) throw new Error(`gdelt ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

/** Goldstein −10..0 (conflict is negative) → 0–4. More negative = more severe. */
function goldsteinSeverity(g: number): number {
  if (g <= -9) return 4;
  if (g <= -7) return 3;
  if (g <= -5) return 2;
  return 1;
}

function normalize(fc: FeatureCollection, bbox: Bbox): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const quad = Number(p.quad) || 0;
    const g = p.goldstein != null ? Number(p.goldstein) : NaN;
    // material conflict OR clearly hostile events only
    if (!(quad === 4 || (Number.isFinite(g) && g <= -5))) continue;
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const af = argusFeature(lng, lat, {
      id: `conflict-${p.id}`,
      layerId: "conflict",
      title: String(p.place ?? "Conflict event"),
      severity: Number.isFinite(g) ? goldsteinSeverity(g) : 2,
      goldstein: Number.isFinite(g) ? String(g) : "",
      domain: String(p.domain ?? ""),
      url: String(p.url ?? ""),
    });
    if (af) out.push(af);
  }
  return out.slice(0, conflict.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: String(p.title ?? "Conflict event"),
    subtitle: `GDELT · ${String(p.domain || "conflict")}`,
    color: COLOR,
    center: pointCenter(f),
    url: String(p.url ?? ""),
    rows: [
      ["Intensity", p.goldstein !== "" ? `Goldstein ${p.goldstein}` : "—"],
      ["Source", String(p.domain || "—")],
    ] as [string, string][],
  };
}

export const conflict: LayerModule = {
  id: "conflict",
  label: "Conflict",
  color: COLOR,
  group: "signals",
  minZoom: 0,
  maxFeatures: 1500,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "conflict", color: COLOR, describe, heatUntil: 6, clusterMaxZoom: 8 });
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
