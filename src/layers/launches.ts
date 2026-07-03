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

// Upcoming rocket launches (Launch Library 2) at their real pads, severity =
// imminence. Countdown is computed client-side from the T-0 timestamp.
const COLOR = "#63e6e2";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(45 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "launches", cooldownMs: 300_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchLaunches(): Promise<FeatureCollection> {
  const res = await fetch("/api/launches");
  if (!res.ok) throw new Error(`launches ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

function countdown(netMs: number): string {
  const dt = netMs - Date.now();
  if (dt <= 0) return "now / recent";
  const d = Math.floor(dt / 86_400_000);
  const h = Math.floor((dt % 86_400_000) / 3_600_000);
  const m = Math.floor((dt % 3_600_000) / 60_000);
  return d > 0 ? `T-${d}d ${h}h` : `T-${h}h ${m}m`;
}

function normalize(fc: FeatureCollection, bbox: Bbox): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const af = argusFeature(lng, lat, {
      id: `launch-${p.name}`,
      layerId: "launches",
      title: String(p.name ?? "Launch"),
      severity: Number(p.severity) || 1,
      ts: p.ts ? Number(p.ts) : undefined,
      net: String(p.net ?? ""),
      pad: String(p.pad ?? ""),
      provider: String(p.provider ?? ""),
      status: String(p.status ?? ""),
    });
    if (af) out.push(af);
  }
  return out;
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  const netMs = Number(p.ts) || 0;
  return {
    title: String(p.title ?? "Launch"),
    subtitle: `${String(p.provider || "launch")} · ${String(p.status || "")}`,
    color: COLOR,
    center: pointCenter(f),
    rows: [
      ["Countdown", netMs ? countdown(netMs) : "—"],
      ["T-0", p.net ? String(p.net).replace("T", " ").slice(0, 17) + "Z" : "—"],
      ["Pad", String(p.pad || "—")],
    ] as [string, string][],
  };
}

export const launches: LayerModule = {
  id: "launches",
  label: "Launches",
  color: COLOR,
  group: "movement",
  minZoom: 0,
  maxFeatures: 60,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "launches", color: COLOR, describe, heatUntil: 2, clusterMaxZoom: 4 });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("launches", fetchLaunches, EMPTY);
    const feats = normalize(value, bufferBbox(aoi.bbox, 0.3));
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: () => fetchLaunches(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
