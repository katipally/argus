"use client";

import { useCallback } from "react";
import Map, { type MapRef } from "react-map-gl/maplibre";
import {
  NavigationControl,
  type MapLibreEvent,
  type Map as MlMap,
  type LayerSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { BASEMAP_STYLE_URL, STYLE_URLS, INITIAL_VIEW } from "./basemap-style";
import { OUR_SOURCES } from "./our-sources";
import { useArgusStore, type ViewOptions } from "@/src/store/useArgusStore";

type Props = {
  onMapReady?: (map: MlMap) => void;
  mapRef?: React.Ref<MapRef>;
  children?: React.ReactNode;
};

// Layers rebuilt per-style by ensureExtras (they reference the style's own
// sources) — everything else Argus added is carried across style switches.
const REBUILT_LAYERS = new Set(["esri-sat-layer", "argus-buildings"]);

/**
 * Style-switch that KEEPS every Argus source/layer: copy over any source the
 * new style doesn't know (all our custom ids) plus the layers drawn from them,
 * appended above the new style's own layers in their original order.
 */
function preserveArgus(prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
  if (!prev) return next;
  const kept: StyleSpecification["sources"] = {};
  for (const [id, src] of Object.entries(prev.sources ?? {})) {
    if (!(id in (next.sources ?? {})) && id !== "esri-sat") kept[id] = src;
  }
  const keptLayers = (prev.layers ?? []).filter((l) => {
    if (REBUILT_LAYERS.has(l.id)) return false;
    const src = (l as LayerSpecification & { source?: string }).source;
    return !!src && src in kept;
  });
  return {
    ...next,
    sources: { ...next.sources, ...kept },
    layers: [...next.layers, ...keptLayers],
    terrain: prev.terrain,
  };
}

// add-once per style: satellite raster + 3D building extrusions.
// Esri World Imagery legacy endpoint is keyless and unmetered — verified live
// to z19–21 (~1 m). Free for non-revenue use with attribution.
function ensureExtras(map: MlMap) {
  const style = map.getStyle();
  // Insert imagery just below the first SYMBOL (label) layer — i.e. ABOVE every
  // base fill/line INCLUDING building footprints. Otherwise the vector style's
  // building polygons render on top of satellite as black boxes.
  const beforeId = style.layers?.find((l) => l.type === "symbol")?.id;

  if (!map.getSource("esri-sat")) {
    map.addSource("esri-sat", {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    });
  }
  if (!map.getLayer("esri-sat-layer")) {
    map.addLayer(
      { id: "esri-sat-layer", type: "raster", source: "esri-sat", layout: { visibility: "none" } },
      beforeId,
    );
  }
  // 3D buildings from whatever vector source the basemap uses (OpenMapTiles schema)
  if (!map.getLayer("argus-buildings")) {
    const vecSrc = Object.entries(style.sources ?? {}).find(([, s]) => s.type === "vector")?.[0];
    if (vecSrc) {
      try {
        map.addLayer(
          {
            id: "argus-buildings",
            type: "fill-extrusion",
            source: vecSrc,
            "source-layer": "building",
            minzoom: 13,
            layout: { visibility: "none" },
            paint: {
              "fill-extrusion-color": [
                "interpolate",
                ["linear"],
                ["coalesce", ["get", "render_height"], 0],
                0, "#2a4a6b",
                30, "#3a6390",
                120, "#5794c6",
                250, "#7fbdec",
              ],
              "fill-extrusion-height": ["coalesce", ["get", "render_height"], 5],
              "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
              "fill-extrusion-opacity": 0.92,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          beforeId,
        );
      } catch {
        /* schema without a building layer — skip */
      }
    }
  }
}

// Zoom-tiered label hierarchy. OpenFreeMap's dark style labels every country
// from z0 (a cluttered flood at world view) and never labels continents/oceans.
// We (a) push country/state/city labels to a sensible minzoom so the globe view
// breathes, and (b) add continent + ocean labels that carry the low-zoom view —
// so it reads continents → countries → states → cities as you zoom in.
// Idempotent: safe to call on every style load.
const LABEL_MINZOOM: Record<string, [number, number]> = {
  // id: [minzoom, keep-existing-maxzoom]
  place_country_major: [2.3, 6],
  place_country_minor: [3.3, 8],
  place_country_other: [3.6, 8],
  place_state: [4.5, 12],
  place_city_large: [4.0, 12],
  place_city: [6.0, 14],
  place_town: [8.0, 15],
  place_village: [10.0, 14],
};
const LABEL_TEXT = ["coalesce", ["get", "name:latin"], ["get", "name"]] as unknown;

function tuneLabels(map: MlMap) {
  for (const [id, [min, max]] of Object.entries(LABEL_MINZOOM)) {
    if (map.getLayer(id)) {
      try {
        map.setLayerZoomRange(id, min, max);
      } catch {
        /* layer shape changed upstream — skip */
      }
    }
  }
  const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;

  // Continents — the world-view anchor. Wide letter-spacing + lower opacity read
  // as a base stratum, not a shout (survives applyView's dark-skin text boost,
  // which only touches color/halo).
  if (!map.getLayer("argus-continents")) {
    try {
      map.addLayer(
        {
          id: "argus-continents",
          type: "symbol",
          source: "openmaptiles",
          "source-layer": "place",
          maxzoom: 3.6,
          filter: ["==", ["get", "class"], "continent"] as unknown as never,
          layout: {
            "text-field": LABEL_TEXT as never,
            "text-font": ["Noto Sans Regular"],
            "text-transform": "uppercase",
            "text-letter-spacing": 0.32,
            "text-size": ["interpolate", ["linear"], ["zoom"], 0, 11, 3, 15] as never,
            "text-max-width": 9,
          },
          paint: {
            "text-color": "#8aa0bd",
            "text-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.75, 3, 0.35] as never,
            "text-halo-color": "#04070d",
            "text-halo-width": 1.4,
          },
        },
        firstSymbol,
      );
    } catch {
      /* schema without continents — skip */
    }
  }

  // Oceans / seas — Point labels live in water_name (the style's own water_name
  // layer only draws LineString river labels).
  if (!map.getLayer("argus-oceans")) {
    try {
      map.addLayer(
        {
          id: "argus-oceans",
          type: "symbol",
          source: "openmaptiles",
          "source-layer": "water_name",
          maxzoom: 5,
          filter: [
            "all",
            ["==", ["geometry-type"], "Point"],
            ["match", ["get", "class"], ["ocean", "sea"], true, false],
          ] as unknown as never,
          layout: {
            "text-field": LABEL_TEXT as never,
            "text-font": ["Noto Sans Regular"],
            "text-letter-spacing": 0.14,
            "text-size": ["interpolate", ["linear"], ["zoom"], 0, 10, 4, 13] as never,
            "text-max-width": 8,
          },
          paint: {
            "text-color": "#5c7fa8",
            "text-opacity": 0.55,
            "text-halo-color": "#04070d",
            "text-halo-width": 1.2,
          },
        },
        firstSymbol,
      );
    } catch {
      /* skip */
    }
  }

  // City-level admin borders — appear as you get close. The style ships country
  // (level 2) + state (level 4); add county/municipal (>=6) where data has them.
  if (!map.getLayer("argus-boundary-local") && map.getSource("openmaptiles")) {
    try {
      map.addLayer({
        id: "argus-boundary-local",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        minzoom: 9,
        filter: [">=", ["get", "admin_level"], 6] as unknown as never,
        paint: {
          "line-color": "#2b3a4d",
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 14, 1] as never,
          "line-dasharray": [2, 2] as never,
          "line-opacity": 0.6,
        },
      });
    } catch {
      /* schema without local boundaries — skip */
    }
  }
}

function applyView(map: MlMap, view: ViewOptions) {
  // Dark and Light are DIFFERENT vector styles; Satellite rides on dark (its
  // labels read well over imagery). Switching styles preserves Argus layers.
  const m = map as unknown as { _argusVectorSkin?: "dark" | "light" };
  const wantVector = view.basemap === "light" ? "light" : "dark";
  if (m._argusVectorSkin !== wantVector) {
    m._argusVectorSkin = wantVector;
    map.setStyle(STYLE_URLS[wantVector], { transformStyle: preserveArgus });
    return; // the style.load handler re-runs applyView on the fresh style
  }

  ensureExtras(map);
  tuneLabels(map);
  const onSat = view.basemap === "satellite";
  map.setLayoutProperty("esri-sat-layer", "visibility", onSat ? "visible" : "none");

  // The dark style's flat building FOOTPRINTS paint as opaque dark polygons that
  // sit on top of the satellite raster — the "blacked-out blocks". Hide that base
  // fill on satellite; restore it on the vector skins where it belongs.
  if (map.getLayer("building")) {
    map.setLayoutProperty("building", "visibility", onSat ? "none" : "visible");
  }
  if (map.getLayer("argus-buildings")) {
    map.setLayoutProperty("argus-buildings", "visibility", view.buildings ? "visible" : "none");
    if (view.buildings) {
      // Over satellite, extrude as a pale translucent "city model" so real
      // rooftops show through and buildings read as 3D massing, not black boxes.
      // On vector skins, the glowing blue gradient.
      map.setPaintProperty(
        "argus-buildings",
        "fill-extrusion-color",
        onSat
          ? "#d3ddeb"
          : ([
              "interpolate",
              ["linear"],
              ["coalesce", ["get", "render_height"], 0],
              0, "#2a4a6b",
              30, "#3a6390",
              120, "#5794c6",
              250, "#7fbdec",
            ] as unknown as string),
      );
      map.setPaintProperty("argus-buildings", "fill-extrusion-opacity", onSat ? 0.5 : 0.92);
    }
  }
  try {
    map.setProjection({ type: view.projection });
  } catch {
    /* ignore */
  }
  // 3D terrain (keyless AWS terrarium DEM) — the Google-Earth relief
  if (view.terrain) {
    if (!map.getSource("terrain-dem")) {
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 14,
      });
    }
    map.setTerrain({ source: "terrain-dem", exaggeration: 1.3 });
  } else {
    map.setTerrain(null);
  }
  // basemap labels on/off (leave our data symbol layers alone). The bright
  // text boost only applies on the dark skin / satellite — positron's own
  // dark-on-light labels are already right.
  const boost = wantVector === "dark";
  for (const l of map.getStyle().layers ?? []) {
    const src = (l as LayerSpecification & { source?: string }).source;
    if (l.type === "symbol" && src && !OUR_SOURCES.has(src)) {
      map.setLayoutProperty(l.id, "visibility", view.labels ? "visible" : "none");
      if (view.labels && boost) {
        try {
          map.setPaintProperty(l.id, "text-color", "#eaf2ff");
          map.setPaintProperty(l.id, "text-halo-color", "#04070d");
          map.setPaintProperty(l.id, "text-halo-width", 1.4);
        } catch {
          /* icon-only symbol layer — no text paint */
        }
      }
    }
  }
  // Sky/atmosphere per skin.
  try {
    // Dark, near-flat sky — the bright "sunshine" halo the atmosphere rim used
    // to paint at the top of the globe is removed (atmosphere-blend ~0). Dark
    // skin: keep only a whisper of rim at the widest zoom, gone by z2.
    map.setSky(
      wantVector === "dark"
        ? {
            "sky-color": "#090c11",
            "horizon-color": "#0d131b",
            "fog-color": "#05070a",
            "sky-horizon-blend": 0.4,
            "horizon-fog-blend": 0.4,
            "fog-ground-blend": 0.3,
            "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.12, 2, 0],
          }
        : {
            "sky-color": "#cdddec",
            "horizon-color": "#dbe8f4",
            "fog-color": "#eef3f8",
            "sky-horizon-blend": 0.5,
            "horizon-fog-blend": 0.4,
            "fog-ground-blend": 0.3,
            "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.2, 2, 0],
          },
    );
  } catch {
    /* older engines ignore */
  }
  // Subtle directional light so 3D buildings gain depth.
  try {
    (map as unknown as { setLight?: (l: object) => void }).setLight?.({
      anchor: "viewport",
      color: "#ffffff",
      intensity: 0.4,
      position: [1.3, 210, 30],
    });
  } catch {
    /* ignore */
  }
}

export default function GlobeMap({ onMapReady, mapRef, children }: Props) {
  const handleLoad = useCallback(
    (e: MapLibreEvent) => {
      const map = e.target;
      (map as unknown as { _argusVectorSkin?: string })._argusVectorSkin = "dark";
      try {
        map.setProjection({ type: "globe" });
      } catch {
        /* ignore */
      }
      map.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");

      // Silence "image X could not be loaded" spam: OpenFreeMap styles reference
      // sprite images our request doesn't ship. Feed a 1×1 transparent pixel.
      map.on("styleimagemissing", (e: { id: string }) => {
        if (map.hasImage(e.id)) return;
        map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
      });

      // After a skin switch loads, re-apply view settings on the fresh style.
      map.on("style.load", () => {
        applyView(map, useArgusStore.getState().view);
      });

      applyView(map, useArgusStore.getState().view);
      useArgusStore.subscribe((s, p) => {
        if (s.view !== p.view) applyView(map, s.view);
      });

      onMapReady?.(map);
    },
    [onMapReady],
  );

  return (
    <Map
      ref={mapRef}
      initialViewState={INITIAL_VIEW}
      mapStyle={BASEMAP_STYLE_URL}
      style={{ position: "absolute", inset: 0 }}
      maxPitch={85}
      onLoad={handleLoad}
      attributionControl={{ compact: true }}
    >
      {children}
    </Map>
  );
}
