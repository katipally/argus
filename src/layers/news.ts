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

const COLOR = "#c9a6ff";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const cache = new BboxCache<FeatureCollection>(15 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "news", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchGdelt(): Promise<FeatureCollection> {
  const res = await fetch("/api/gdelt");
  if (!res.ok) throw new Error(`gdelt ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

/** Coverage volume → 0–4 (how widely the event is being reported). */
function volumeSeverity(mentions: number): number {
  if (mentions >= 50) return 4;
  if (mentions >= 15) return 3;
  if (mentions >= 5) return 2;
  if (mentions >= 2) return 1;
  return 0;
}

function normalize(fc: FeatureCollection, bbox: ReturnType<typeof bufferBbox>): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const mentions = Number(p.mentions) || 1;
    const af = argusFeature(lng, lat, {
      id: String(p.id ?? p.url ?? `${lng},${lat}`),
      layerId: "news",
      title: String(p.place ?? "Reported event"),
      severity: volumeSeverity(mentions),
      ts: p.date ? Date.parse(gdeltDate(String(p.date))) || undefined : undefined,
      domain: String(p.domain ?? ""),
      tone: p.tone != null ? String(p.tone) : "",
      mentions: String(mentions),
      url: String(p.url ?? ""),
    });
    if (af) out.push(af);
  }
  return out.slice(0, news.maxFeatures);
}

/** GDELT DATEADDED is YYYYMMDDHHMMSS — make it ISO-ish for Date.parse. */
function gdeltDate(d: string): string {
  if (d.length >= 14) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}Z`;
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  const tone = p.tone !== "" && p.tone != null ? Number(p.tone) : null;
  return {
    title: String(p.title ?? "Reported event"),
    subtitle: `GDELT · ${String(p.domain || "news")}`,
    color: COLOR,
    center: pointCenter(f),
    url: String(p.url ?? ""),
    rows: [
      ["Coverage", `${p.mentions ?? "—"} mentions`],
      ["Sentiment", tone == null ? "—" : tone > 1 ? "positive" : tone < -1 ? "negative" : "neutral"],
      ["Source", String(p.domain || "—")],
    ] as [string, string][],
  };
}

export const news: LayerModule = {
  id: "news",
  label: "News",
  color: COLOR,
  group: "signals",
  minZoom: 0,
  maxFeatures: 3000,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "news", color: COLOR, describe, heatUntil: 7, clusterMaxZoom: 9 });
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
