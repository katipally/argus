import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";

// Drops a pin + soft halo on the globe at the right-clicked place so the user
// can see exactly which point the info card / detail workspace refers to.
const SRC = "pin-src";
const HALO = "pin-halo";
const DOT = "pin-dot";

let mapRef: MlMap | null = null;

function apply(place: { lat: number; lon: number } | null): void {
  const src = mapRef?.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  src.setData(
    place
      ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [place.lon, place.lat] } }
      : { type: "FeatureCollection", features: [] },
  );
}

export function initPinLayer(map: MlMap): void {
  mapRef = map;
  map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: HALO,
    type: "circle",
    source: SRC,
    paint: {
      "circle-radius": 26,
      "circle-color": "#38e0ff",
      "circle-opacity": 0.12,
      "circle-blur": 0.6,
    },
  });
  map.addLayer({
    id: DOT,
    type: "circle",
    source: SRC,
    paint: {
      "circle-radius": 6,
      "circle-color": "#38e0ff",
      "circle-stroke-color": "#eaf6ff",
      "circle-stroke-width": 1.5,
    },
  });
  useArgusStore.subscribe((s, p) => {
    if (s.place !== p.place) apply(s.place);
  });
  apply(useArgusStore.getState().place);
}
