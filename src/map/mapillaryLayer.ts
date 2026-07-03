import type { Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";

// Mapillary street-imagery coverage — OPTIONAL second source, far wider global
// coverage than Panoramax. Activates only when a free client token is set
// (NEXT_PUBLIC_MAPILLARY_TOKEN); with no token this is a no-op and Argus stays
// fully keyless on Panoramax alone. Rendered in a distinct blue so the two
// coverage networks read as separate sources on the map.
//
// Client tokens (MLY|…) are read-scoped and per-app rate-limited — Mapillary
// designs them for client embedding, so exposing one via NEXT_PUBLIC is fine.
// API v4 vector tiles: tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}
// source-layers: `sequence` (lines, z6–14) and `image` (points, z14+).
const TOKEN = process.env.NEXT_PUBLIC_MAPILLARY_TOKEN;

const SRC = "mapillary-src";
const LINE = "mapillary-seq";
const PT = "mapillary-pic";
const COLOR = "#2e8fff";

export function mapillaryEnabled(): boolean {
  return !!TOKEN;
}

export function initMapillary(map: MlMap): void {
  if (!TOKEN || map.getSource(SRC)) return;
  map.addSource(SRC, {
    type: "vector",
    tiles: [
      `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${TOKEN}`,
    ],
    minzoom: 6,
    maxzoom: 14,
    attribution:
      '<a href="https://www.mapillary.com" target="_blank" rel="noopener">Mapillary</a>',
  });
  map.addLayer({
    id: LINE,
    type: "line",
    source: SRC,
    "source-layer": "sequence",
    minzoom: 11,
    layout: { "line-cap": "round" },
    paint: {
      "line-color": COLOR,
      "line-width": 1,
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.1, 13, 0.22],
    },
  });
  map.addLayer({
    id: PT,
    type: "circle",
    source: SRC,
    "source-layer": "image",
    minzoom: 16,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 2, 18, 5],
      "circle-color": COLOR,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 16, 0.45, 17.5, 0.85],
      "circle-stroke-color": "#02040a",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 16, 0.4, 17.5, 1],
    },
  });

  // Mapillary thumbs need an async graph-API lookup, so skip the intermediate
  // thumbnail preview and open the viewer directly (Panoramax keeps its thumb
  // flow because its thumb URL is deterministic).
  map.on("click", PT, (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id;
    if (id) useArgusStore.getState().setPanoImageId({ id: String(id), source: "mapillary" });
  });
  map.on("mouseenter", PT, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", PT, () => {
    map.getCanvas().style.cursor = "";
  });
}
