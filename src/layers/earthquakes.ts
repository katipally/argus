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

const COLOR = "#22d3ee";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(5 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "earthquakes", cooldownMs: 60_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

let lastSources = "";

async function fetchUsgs(bbox: Bbox): Promise<FeatureCollection> {
  const b = clampBbox(bbox);
  const url = `/api/usgs?west=${b.west}&south=${b.south}&east=${b.east}&north=${b.north}&days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  lastSources = res.headers.get("X-Argus-Sources") ?? "";
  return (await res.json()) as FeatureCollection;
}

/** magnitude → 0–4 severity */
function magSeverity(mag: number): number {
  if (mag >= 6) return 4;
  if (mag >= 5) return 3;
  if (mag >= 4) return 2;
  if (mag >= 2.5) return 1;
  return 0;
}

/** USGS GeoJSON → normalized ArgusFeatures (min-mag filtered so clusters agree). */
function normalize(fc: FeatureCollection, minMag: number): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const mag = typeof p.mag === "number" ? p.mag : NaN;
    if (Number.isFinite(mag) && mag < minMag) continue;
    const [lng, lat] = (f.geometry.coordinates as number[]);
    const af = argusFeature(lng, lat, {
      id: String(f.id ?? p.code ?? `${lng},${lat}`),
      layerId: "earthquakes",
      title: String(p.place ?? "Seismic event"),
      severity: magSeverity(mag),
      ts: typeof p.time === "number" ? p.time : undefined,
      mag: Number.isFinite(mag) ? mag : null,
      depth: typeof (f.geometry.coordinates as number[])[2] === "number" ? (f.geometry.coordinates as number[])[2] : null,
      source: typeof p.source === "string" ? p.source : "USGS",
    });
    if (af) out.push(af);
  }
  return out.slice(0, earthquakes.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  const t = typeof p.ts === "number" ? new Date(p.ts).toUTCString() : "—";
  return {
    title: String(p.title ?? "Seismic event"),
    subtitle: `${p.source ?? "USGS"} · seismic`,
    color: COLOR,
    center: pointCenter(f),
    rows: [
      ["Magnitude", p.mag != null ? `M ${p.mag}` : "—"],
      ["Depth", p.depth != null ? `${Number(p.depth).toFixed(0)} km` : "—"],
      ["Time (UTC)", t],
    ] as [string, string][],
  };
}

export const earthquakes: LayerModule = {
  id: "earthquakes",
  label: "Earthquakes",
  color: COLOR,
  group: "earth",
  minZoom: 0,
  maxFeatures: 2000,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "earthquakes", color: COLOR, describe });
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
    const { value, status } = await guarded(bboxKey(bbox), () => fetchUsgs(bbox), EMPTY);
    const feats = normalize(value, store.filters.earthquakes.minMag);
    render.setData({ type: "FeatureCollection", features: feats });
    const n = lastSources ? lastSources.split(",").length : 0;
    store.setLayerRuntime(this.id, {
      count: feats.length,
      status,
      updatedAt: Date.now(),
      note: n ? `${n} source${n > 1 ? "s" : ""}` : undefined,
    });
  },

  query: (bbox) => fetchUsgs(bbox),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
