import type {
  Map as MlMap,
  GeoJSONSource,
  MapLayerMouseEvent,
  MapGeoJSONFeature,
  ExpressionSpecification,
} from "maplibre-gl";
import type { FeatureCollection, Feature } from "geojson";
import type { EntityDescriptor } from "@/src/layers/interactions";
import { useArgusStore } from "@/src/store/useArgusStore";
import { OUR_SOURCES } from "@/src/map/our-sources";
import { currentAoiClip, inClip } from "./aoiClip";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// A focused region's bbox is a rectangle — for a country it drags in oceans and
// neighbours (US bbox reaches Alaska & the Pacific; India's reaches China & SE
// Asia). Filter every hotspot layer to the region's REAL polygon plus a ~110km
// halo, so you see what's IN or genuinely NEAR the selection, not its rectangle.
// Shared with the streaming movement layers via src/core/aoiClip.
const AOI_MARGIN_DEG = 1.0;

function filterToAoi(features: Feature[]): Feature[] {
  const clip = currentAoiClip(AOI_MARGIN_DEG);
  if (!clip) return features; // no region focus → no spatial filter
  return features.filter((f) => {
    if (f.geometry?.type !== "Point") return true; // lines/polygons pass through
    const [lng, lat] = f.geometry.coordinates as number[];
    return inClip(lng, lat, clip);
  });
}

/**
 * Which presentation band a zoom falls in. Below `heatUntil` we show a density
 * heatmap (hotspots, not dot-soup); native MapLibre clustering merges points into
 * counted circles until `clusterMaxZoom`; above that every point is a symbol.
 */
export function presentationBand(
  zoom: number,
  heatUntil: number,
  clusterMaxZoom: number,
): "heat" | "cluster" | "symbol" {
  if (zoom < heatUntil) return "heat";
  if (zoom <= clusterMaxZoom) return "cluster";
  return "symbol";
}

export interface HotspotOptions {
  /** Layer id — also the prefix for its MapLibre source/layer ids. */
  id: string;
  color: string;
  /** Turn a picked feature into panel/tooltip data. */
  describe: (f: MapGeoJSONFeature) => EntityDescriptor;
  /** Zoom below which the heatmap shows and clusters fade in. Default 6. */
  heatUntil?: number;
  /** Zoom at/below which points cluster. Default 8. */
  clusterMaxZoom?: number;
  /** Cluster grouping radius in px. Default 60. */
  clusterRadius?: number;
}

export interface HotspotRender {
  setData(fc: FeatureCollection): void;
  setVisible(visible: boolean): void;
  destroy(): void;
  layerIds: string[];
}

/**
 * Shared zoom-adaptive renderer for any static point layer: heatmap → counted
 * clusters → individual symbols, sized by severity, in the layer's accent color.
 * One implementation so every layer looks and behaves the same. Moving-entity
 * layers (planes/ships) keep their own live symbols and don't use this.
 */
export function createHotspotRender(map: MlMap, opts: HotspotOptions): HotspotRender {
  const { id, color, describe } = opts;
  const heatUntil = opts.heatUntil ?? 6;
  const clusterMaxZoom = opts.clusterMaxZoom ?? 8;
  const src = `${id}-src`;
  const HEAT = `${id}-heat`;
  const CLU = `${id}-cluster`;
  const CLU_TXT = `${id}-cluster-count`;
  const GLOW = `${id}-glow`;
  const CORE = `${id}-core`;

  OUR_SOURCES.add(src);

  map.addSource(src, {
    type: "geojson",
    data: EMPTY,
    cluster: true,
    clusterRadius: opts.clusterRadius ?? 60,
    clusterMaxZoom,
  });

  // severity-driven size, shared by glow/core
  const sev: ExpressionSpecification = ["coalesce", ["get", "severity"], 0];
  const glowR: ExpressionSpecification = ["interpolate", ["linear"], sev, 0, 7, 4, 24];
  const coreR: ExpressionSpecification = ["interpolate", ["linear"], sev, 0, 2, 4, 7];

  // heatmap — hotspots at low zoom, fading out as clusters take over
  map.addLayer({
    id: HEAT,
    type: "heatmap",
    source: src,
    maxzoom: heatUntil + 1,
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "point_count"], 1], 1, 0.5, 60, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, heatUntil, 1.2],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 14, heatUntil, 26],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], heatUntil - 1.5, 0.75, heatUntil + 1, 0],
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0,0,0,0)",
        0.2, `${color}44`,
        0.5, `${color}99`,
        1, color,
      ],
    },
  });

  // cluster circles — fade in as the heatmap fades out
  const cluOpacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], heatUntil - 1.5, 0.15, heatUntil + 0.5, 0.85];
  map.addLayer({
    id: CLU,
    type: "circle",
    source: src,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": color,
      "circle-opacity": cluOpacity,
      "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 12, 25, 20, 200, 32],
      "circle-stroke-color": "#e6feff",
      "circle-stroke-width": 1,
      "circle-stroke-opacity": cluOpacity,
    },
  });
  map.addLayer({
    id: CLU_TXT,
    type: "symbol",
    source: src,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
    },
    paint: {
      "text-color": "#04060b",
      "text-halo-color": color,
      "text-halo-width": 0.6,
      "text-opacity": ["interpolate", ["linear"], ["zoom"], heatUntil - 0.5, 0, heatUntil + 0.5, 1],
    },
  });

  // unclustered glow + core (the individual symbols)
  map.addLayer({
    id: GLOW,
    type: "circle",
    source: src,
    filter: ["!", ["has", "point_count"]],
    paint: { "circle-radius": glowR, "circle-color": color, "circle-blur": 1, "circle-opacity": 0.35 },
  });
  // Core: bright dot carrying a DARK casing so it stays legible on any skin —
  // dark vector, bright satellite, or cloudy GIBS imagery. The colored glow
  // beneath carries layer identity; the casing keeps the dot crisp over clouds.
  // ponytail: skin-agnostic casing beats a skin-detection broadcast system.
  map.addLayer({
    id: CORE,
    type: "circle",
    source: src,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": coreR,
      "circle-color": color,
      "circle-stroke-color": "#02040a",
      "circle-stroke-width": 1.6,
      "circle-opacity": 1,
      "circle-stroke-opacity": 0.9,
    },
  });

  // interactions: hover/click individual points; click a cluster → zoom to split it
  const hover = (e: MapLayerMouseEvent) => {
    map.getCanvas().style.cursor = "pointer";
    const f = e.features?.[0];
    if (!f) return;
    const d = describe(f);
    useArgusStore.getState().setHovered({ x: e.point.x, y: e.point.y, title: d.title, rows: d.rows, color: d.color });
  };
  const leave = () => {
    map.getCanvas().style.cursor = "";
    useArgusStore.getState().setHovered(null);
  };
  const click = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    useArgusStore.getState().setSelected({ layerId: id, ...describe(f) });
  };
  for (const lyr of [CORE, GLOW]) {
    map.on("mousemove", lyr, hover);
    map.on("mouseleave", lyr, leave);
    map.on("click", lyr, click);
  }
  const clusterClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    const cid = f?.properties?.cluster_id;
    if (cid == null) return;
    const source = map.getSource(src) as GeoJSONSource | undefined;
    source?.getClusterExpansionZoom(cid as number).then((zoom) => {
      const geo = f!.geometry;
      if (geo.type === "Point") {
        map.easeTo({ center: [geo.coordinates[0], geo.coordinates[1]], zoom: zoom + 0.4, duration: 700 });
      }
    }).catch(() => {});
  };
  map.on("click", CLU, clusterClick);
  map.on("mouseenter", CLU, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", CLU, () => (map.getCanvas().style.cursor = ""));

  const layerIds = [HEAT, CLU, CLU_TXT, GLOW, CORE];

  // ── time playback ──────────────────────────────────────────────────────────
  // Central 24h-scrubber support: when playback is active, only features whose
  // `ts` is at/before the scrub time render (features without ts always show).
  // One implementation here = every hotspot layer replays for free.
  let lastFc: FeatureCollection = EMPTY;
  const applyData = () => {
    const pb = useArgusStore.getState().playback;
    let features = filterToAoi(lastFc.features); // spatial: region polygon + halo
    if (pb.active) {
      features = features.filter((f) => {
        const ts = Number(f.properties?.ts);
        return !Number.isFinite(ts) || ts === 0 || ts <= pb.t;
      });
    }
    (map.getSource(src) as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features,
    });
  };
  // re-apply on playback OR region change, so the spatial filter follows the AOI
  // immediately even for streaming layers that don't re-fetch on selection.
  const unsubPlayback = useArgusStore.subscribe((s, p) => {
    if (s.playback !== p.playback || s.aoi !== p.aoi || s.selection !== p.selection) applyData();
  });

  return {
    setData(fc) {
      lastFc = fc;
      applyData();
    },
    setVisible(visible) {
      const v = visible ? "visible" : "none";
      for (const l of layerIds) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", v);
    },
    destroy() {
      unsubPlayback();
      for (const l of layerIds) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(src)) map.removeSource(src);
      OUR_SOURCES.delete(src);
    },
    layerIds,
  };
}
