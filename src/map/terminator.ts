import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { Feature, Polygon } from "geojson";
import { useArgusStore } from "@/src/store/useArgusStore";

// Live day/night terminator. Computes the night hemisphere as a GeoJSON polygon
// from the sun's position at a given instant and shades it — so it reprojects
// natively on globe AND flat (no raster tearing). Self-contained solar math
// (ported from the well-known leaflet.terminator approach), no dependency.

const SRC = "terminator-src";
const FILL = "terminator-fill";
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

const julian = (ms: number) => ms / 86_400_000 + 2440587.5;
const gmst = (j: number) => ((18.697374558 + 24.06570982441908 * (j - 2451545.0)) % 24 + 24) % 24;

function sunEclipticLon(j: number): number {
  const n = j - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  return L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
}
function obliquity(j: number): number {
  return 23.4393 - 0.0000004 * (j - 2451545.0);
}

/** Night hemisphere polygon for an instant (epoch ms). */
export function nightPolygon(ms: number): Polygon {
  const j = julian(ms);
  const lambda = sunEclipticLon(j) * D2R;
  const eps = obliquity(j) * D2R;
  const delta = Math.asin(Math.sin(eps) * Math.sin(lambda)) * R2D; // solar declination (deg)
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D; // right ascension (deg)
  const gst = gmst(j);

  let tanD = Math.tan(delta * D2R);
  if (Math.abs(tanD) < 1e-3) tanD = tanD < 0 ? -1e-3 : 1e-3; // avoid equinox blow-up

  const curve: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += 1) {
    const lst = gst + lng / 15;
    const ha = (lst * 15 - alpha) * D2R; // hour angle
    const lat = Math.atan(-Math.cos(ha) / tanD) * R2D;
    curve.push([lng, lat]);
  }
  // close the ring toward the pole that is in polar night
  const pole = delta > 0 ? -90 : 90;
  const ring: [number, number][] = [[-180, pole], ...curve, [180, pole], [-180, pole]];
  return { type: "Polygon", coordinates: [ring] };
}

let mapRef: MlMap | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function render(): void {
  const src = mapRef?.getSource(SRC) as GeoJSONSource | undefined;
  if (!src || !mapRef) return;
  const view = useArgusStore.getState().view;
  if (!view.daynight) {
    mapRef.setLayoutProperty(FILL, "visibility", "none");
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  mapRef.setLayoutProperty(FILL, "visibility", "visible");
  const ms = view.clockMs ?? Date.now();
  const f: Feature<Polygon> = { type: "Feature", properties: {}, geometry: nightPolygon(ms) };
  src.setData({ type: "FeatureCollection", features: [f] });
  // advance the live terminator every minute (only while following real time)
  if (view.clockMs == null && !timer) timer = setInterval(render, 60_000);
  if (view.clockMs != null && timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function initTerminator(map: MlMap): void {
  mapRef = map;
  map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // sit above the imagery/base but below vector lines + labels
  const beforeId = map.getStyle().layers?.find((l) => l.type === "line" || l.type === "symbol")?.id;
  map.addLayer(
    {
      id: FILL,
      type: "fill",
      source: SRC,
      layout: { visibility: "none" },
      paint: { "fill-color": "#01030a", "fill-opacity": 0.46 },
    },
    beforeId,
  );
  useArgusStore.subscribe((s, p) => {
    if (s.view.daynight !== p.view.daynight || s.view.clockMs !== p.view.clockMs) render();
  });
  render();
}
