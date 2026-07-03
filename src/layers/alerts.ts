import type { Map as MlMap, GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { bufferBbox, pointInBbox, type Bbox } from "@/src/core/bbox";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { useArgusStore } from "@/src/store/useArgusStore";
import { METEOALARM_COUNTRIES } from "./feeds/meteoalarm-countries";
import { CENTROIDS } from "@/src/geo/country-centroids";

// Official weather warnings under ONE toggle:
//  • US — NWS CAP alerts as real polygons (fill + outline by severity).
//  • Europe — MeteoAlarm (EUMETNET) per-country aggregates as severity dots at
//    the country centroid (feeds carry no geometry — see /api/meteoalarm).
const COLOR = "#ffd24a";
const SRC = "alerts-src";
const FILL = "alerts-fill";
const LINE = "alerts-line";
const EU_SRC = "alerts-eu-src";
const EU_DOT = "alerts-eu-dots";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const SEV_COLOR: Record<string, string> = {
  Extreme: "#ff2d55",
  Severe: "#ff8a3d",
  Moderate: "#ffd24a",
  Minor: "#8affc1",
  Unknown: "#7385a1",
};

const cache = new BboxCache<FeatureCollection>(2 * 60_000);
const breaker = new CircuitBreaker<FeatureCollection>({ name: "alerts", cooldownMs: 120_000 });
const guarded = createGuardedFetch(cache, breaker);

const euCache = new BboxCache<FeatureCollection>(10 * 60_000);
const euBreaker = new CircuitBreaker<FeatureCollection>({ name: "meteoalarm", cooldownMs: 120_000 });
const euGuarded = createGuardedFetch(euCache, euBreaker);

let mapRef: MlMap | null = null;

async function fetchNws(): Promise<FeatureCollection> {
  const res = await fetch("/api/nws");
  if (!res.ok) throw new Error(`nws ${res.status}`);
  return (await res.json()) as FeatureCollection;
}

/** MeteoAlarm countries whose centroid falls inside the (buffered) AOI. */
function euCountriesIn(bbox: Bbox): string[] {
  const out: string[] = [];
  for (const iso of Object.keys(METEOALARM_COUNTRIES)) {
    const c = CENTROIDS[iso];
    if (c && pointInBbox(c[0], c[1], bbox)) out.push(iso);
  }
  return out.slice(0, 6);
}

interface EuCountry {
  iso2: string;
  total: number;
  bySeverity: Record<string, number>;
  events: string[];
  maxSeverity: string;
}

async function fetchMeteoalarm(isos: string[]): Promise<FeatureCollection> {
  if (!isos.length) return EMPTY;
  const res = await fetch(`/api/meteoalarm?countries=${isos.join(",")}`);
  if (!res.ok) throw new Error(`meteoalarm ${res.status}`);
  const d = (await res.json()) as { countries: EuCountry[] };
  const features: Feature<Point>[] = [];
  for (const c of d.countries) {
    if (!c.total) continue;
    const cen = CENTROIDS[c.iso2];
    if (!cen) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: cen },
      properties: {
        iso2: c.iso2,
        total: c.total,
        maxSeverity: c.maxSeverity,
        events: c.events.join(" · "),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Rough bbox test: keep alerts whose first coordinate lands in the AOI. */
function withinAoi(fc: FeatureCollection, bbox: Bbox): FeatureCollection {
  const features = fc.features.filter((f) => {
    const g = f.geometry;
    let c: number[] | undefined;
    if (g?.type === "Polygon") c = g.coordinates[0]?.[0];
    else if (g?.type === "MultiPolygon") c = g.coordinates[0]?.[0]?.[0];
    return c ? pointInBbox(c[0], c[1], bbox) : false;
  });
  return { type: "FeatureCollection", features };
}

export const alerts: LayerModule = {
  id: "alerts",
  label: "Weather alerts",
  color: COLOR,
  group: "sky",
  minZoom: 0,
  maxFeatures: 2000,
  defaultEnabled: false,

  init(map) {
    mapRef = map;
    map.addSource(SRC, { type: "geojson", data: EMPTY });
    const sevColorExpr = [
      "match",
      ["get", "severity"],
      "Extreme", SEV_COLOR.Extreme,
      "Severe", SEV_COLOR.Severe,
      "Moderate", SEV_COLOR.Moderate,
      "Minor", SEV_COLOR.Minor,
      SEV_COLOR.Unknown,
    ] as unknown as string;
    map.addLayer({
      id: FILL,
      type: "fill",
      source: SRC,
      paint: { "fill-color": sevColorExpr, "fill-opacity": 0.18 },
    });
    map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      paint: { "line-color": sevColorExpr, "line-width": 1.2, "line-opacity": 0.9 },
    });

    // European country-level warning dots
    map.addSource(EU_SRC, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: EU_DOT,
      type: "circle",
      source: EU_SRC,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "total"], 1, 6, 50, 10, 300, 16],
        "circle-color": [
          "match", ["get", "maxSeverity"],
          "Extreme", SEV_COLOR.Extreme,
          "Severe", SEV_COLOR.Severe,
          "Moderate", SEV_COLOR.Moderate,
          SEV_COLOR.Minor,
        ] as unknown as string,
        "circle-opacity": 0.75,
        "circle-stroke-color": "#02040a",
        "circle-stroke-width": 1.5,
      },
    });

    map.on("click", FILL, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties ?? {};
      useArgusStore.getState().setSelected({
        layerId: "alerts",
        title: String(p.event ?? "Alert"),
        subtitle: `NWS · ${String(p.severity ?? "")}`,
        color: SEV_COLOR[String(p.severity)] ?? COLOR,
        center: [e.lngLat.lng, e.lngLat.lat],
        url: String(p.url ?? ""),
        rows: [
          ["Area", String(p.area || "—").slice(0, 60)],
          ["Severity", String(p.severity || "—")],
          ["Expires", String(p.expires || "—").slice(0, 16).replace("T", " ")],
        ],
      });
    });
    map.on("click", EU_DOT, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties ?? {};
      useArgusStore.getState().setSelected({
        layerId: "alerts",
        title: `${p.total} active warnings`,
        subtitle: `MeteoAlarm · ${String(p.iso2 ?? "")}`,
        color: SEV_COLOR[String(p.maxSeverity)] ?? COLOR,
        center: [e.lngLat.lng, e.lngLat.lat],
        url: `https://meteoalarm.org?region=${String(p.iso2 ?? "")}`,
        rows: [
          ["Highest", String(p.maxSeverity || "—")],
          ["Types", String(p.events || "—").slice(0, 80)],
        ],
      });
    });
    for (const l of [FILL, EU_DOT]) {
      map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
    }
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    const aoi = store.aoi;
    if (!load || !aoi || !mapRef) {
      (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
      (mapRef?.getSource(EU_SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    const bbox = bufferBbox(aoi.bbox);
    const isos = euCountriesIn(bufferBbox(aoi.bbox, 0.3));
    const [nws, eu] = await Promise.all([
      guarded("nws", fetchNws, EMPTY),
      isos.length
        ? euGuarded(`ma:${isos.join(",")}`, () => fetchMeteoalarm(isos), EMPTY)
        : Promise.resolve({ value: EMPTY, status: "live" as const }),
    ]);
    const within = withinAoi(nws.value, bbox);
    (mapRef.getSource(SRC) as GeoJSONSource | undefined)?.setData(within);
    (mapRef.getSource(EU_SRC) as GeoJSONSource | undefined)?.setData(eu.value);
    const count = within.features.length + eu.value.features.reduce((n, f) => n + (Number(f.properties?.total) || 0), 0);
    store.setLayerRuntime(this.id, { count, status: nws.status, updatedAt: Date.now() });
  },

  query: () => fetchNws(),

  setVisible(visible) {
    if (!mapRef) return;
    const v = visible ? "visible" : "none";
    for (const id of [FILL, LINE, EU_DOT]) if (mapRef.getLayer(id)) mapRef.setLayoutProperty(id, "visibility", v);
  },

  destroy() {
    if (mapRef) {
      for (const id of [FILL, LINE, EU_DOT]) if (mapRef.getLayer(id)) mapRef.removeLayer(id);
      for (const id of [SRC, EU_SRC]) if (mapRef.getSource(id)) mapRef.removeSource(id);
    }
    mapRef = null;
  },
};
