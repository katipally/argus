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

const COLOR = "#fb5c8b";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const TYPE_LABEL: Record<string, string> = {
  EQ: "Earthquake",
  TC: "Cyclone",
  FL: "Flood",
  DR: "Drought",
  VO: "Volcano",
  WF: "Wildfire",
  TS: "Tsunami",
};

const cache = new BboxCache<FeatureCollection>(5 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "disasters", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

let render: HotspotRender | null = null;

async function fetchGdacs(): Promise<FeatureCollection> {
  const res = await fetch("/api/gdacs");
  if (!res.ok) throw new Error(`gdacs ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

const ALERT_SEV: Record<string, number> = { Red: 4, Orange: 3, Green: 1 };

/** GDACS features → ArgusFeatures within the AOI, alert/type filtered at data level. */
function normalize(
  fc: FeatureCollection,
  bbox: ReturnType<typeof bufferBbox>,
  types: string[],
  alerts: string[],
): ArgusFeature[] {
  const out: ArgusFeature[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates as number[];
    if (!pointInBbox(lng, lat, bbox)) continue;
    const eventtype = String(p.eventtype ?? "");
    const alert = String(p.alert ?? "");
    if (types.length && !types.includes(eventtype)) continue;
    if (alerts.length && !alerts.includes(alert)) continue;
    const af = argusFeature(lng, lat, {
      id: String(p.eventid ?? `${lng},${lat}`),
      layerId: "disasters",
      title: String(p.name ?? "Disaster event"),
      severity: ALERT_SEV[alert] ?? 2,
      ts: p.from ? Date.parse(String(p.from)) || undefined : undefined,
      eventtype,
      type: TYPE_LABEL[eventtype] ?? eventtype,
      alert,
      from: String(p.from ?? "").slice(0, 10),
      url: String(p.url ?? ""),
    });
    if (af) out.push(af);
  }
  return out.slice(0, disasters.maxFeatures);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  return {
    title: String(p.title ?? "Disaster event"),
    subtitle: `GDACS · ${String(p.type ?? "Event")}`,
    color: COLOR,
    center: pointCenter(f),
    rows: [
      ["Type", String(p.type || "—")],
      ["Alert", String(p.alert || "—")],
      ["Since", String(p.from || "—")],
    ] as [string, string][],
  };
}

export const disasters: LayerModule = {
  id: "disasters",
  label: "Disasters",
  color: COLOR,
  group: "earth",
  minZoom: 0,
  maxFeatures: 500,
  defaultEnabled: false,

  init(map) {
    render = createHotspotRender(map, { id: "disasters", color: COLOR, describe });
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !render) {
      render?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const { value, status } = await guarded("gdacs", fetchGdacs, EMPTY);
    const { types, alerts } = store.filters.disasters;
    const feats = normalize(value, bufferBbox(aoi.bbox), types, alerts);
    render.setData({ type: "FeatureCollection", features: feats });
    store.setLayerRuntime(this.id, { count: feats.length, status, updatedAt: Date.now() });
  },

  query: () => fetchGdacs(),

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    render?.destroy();
    render = null;
  },
};
