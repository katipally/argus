import type { Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";

// Panoramax (OpenStreetMap-France) street-imagery coverage — KEYLESS, always on.
// Faint coverage lines appear from z11, clickable picture dots from z13; click a
// dot → small thumbnail preview (PanoPreview), click that → full PanoViewer.
export const PANORAMAX_API = "https://panoramax.openstreetmap.fr/api";

/** Deterministic thumbnail URL for a picture id (verified live). */
export const panoThumbUrl = (id: string) => `${PANORAMAX_API}/pictures/${id}/thumb.jpg`;

const SRC = "panoramax-src";
const LINE = "panoramax-seq";
const PT = "panoramax-pic";
const COLOR = "#35e08a";

export function initPanoramax(map: MlMap): void {
  if (map.getSource(SRC)) return;
  map.addSource(SRC, {
    type: "vector",
    tiles: [`${PANORAMAX_API}/map/{z}/{x}/{y}.mvt`],
    minzoom: 0,
    maxzoom: 15,
    attribution:
      '<a href="https://panoramax.fr" target="_blank" rel="noopener">Panoramax</a> (CC-BY-SA)',
  });
  map.addLayer({
    id: LINE,
    type: "line",
    source: SRC,
    "source-layer": "sequences",
    minzoom: 11,
    layout: { "line-cap": "round" },
    paint: {
      "line-color": COLOR,
      "line-width": 1,
      // stay faint — dense cities (Paris) have near-total coverage and the
      // hint must never shout over the basemap
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.12, 13, 0.25],
    },
  });
  map.addLayer({
    id: PT,
    type: "circle",
    source: SRC,
    "source-layer": "pictures",
    // mapped cities have near-total coverage — below z16 the faint LINES carry
    // the hint; clickable dots only appear once streets are wide enough that
    // they read as pickable points instead of a green flood
    minzoom: 16,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 2, 18, 5],
      "circle-color": COLOR,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 16, 0.45, 17.5, 0.85],
      "circle-stroke-color": "#02040a",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 16, 0.4, 17.5, 1],
    },
  });

  map.on("click", PT, (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id;
    if (id)
      useArgusStore
        .getState()
        .setPanoPreview({ id: String(id), x: e.point.x, y: e.point.y, source: "panoramax" });
  });
  map.on("mouseenter", PT, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", PT, () => {
    map.getCanvas().style.cursor = "";
  });
  // the preview is anchored to a screen point — stale once the camera moves
  map.on("movestart", () => {
    if (useArgusStore.getState().panoPreview) useArgusStore.getState().setPanoPreview(null);
  });
}
