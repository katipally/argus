import type { Map as MlMap, MapLayerMouseEvent, MapGeoJSONFeature } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";

export interface EntityDescriptor {
  title: string;
  subtitle?: string;
  rows: [string, string][];
  color: string;
  center: [number, number];
  /** Live camera still — EntityPanel renders + refreshes it while open. */
  imageUrl?: string;
  /** HLS (.m3u8) live stream — EntityPanel plays it, still image as fallback. */
  streamUrl?: string;
  /** Embeddable iframe URL (e.g. YouTube Live) — EntityPanel embeds it. */
  embedUrl?: string;
  /** External source link (e.g. a news article) — opened from the panel. */
  url?: string;
}

/** Bbox-center of any GeoJSON geometry (Point returns itself). */
export function geomCenter(g: GeoJSON.Geometry): [number, number] {
  if (g.type === "Point") return [g.coordinates[0], g.coordinates[1]];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const walk = (c: unknown): void => {
    if (typeof (c as number[])[0] === "number") {
      const [lng, lat] = c as number[];
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    } else for (const child of c as unknown[]) walk(child);
  };
  if (g.type === "GeometryCollection") g.geometries.forEach((sub) => walk((sub as { coordinates?: unknown }).coordinates ?? []));
  else walk(g.coordinates ?? []);
  if (!Number.isFinite(west)) return [0, 0];
  return [(west + east) / 2, (south + north) / 2];
}

/** Feature's display center — bbox-center for lines/polygons, the point itself for points. */
export function pointCenter(f: MapGeoJSONFeature): [number, number] {
  return geomCenter(f.geometry);
}

/**
 * Wire hover (→ HoverTooltip) and click (→ EntityPanel) for a rendered layer.
 * `describe` turns a feature into display data. Shared by every point layer.
 */
export function attachEntityInteractions(
  map: MlMap,
  renderLayerId: string,
  layerKey: string,
  describe: (f: MapGeoJSONFeature) => EntityDescriptor,
): void {
  map.on("mousemove", renderLayerId, (e: MapLayerMouseEvent) => {
    map.getCanvas().style.cursor = "pointer";
    const f = e.features?.[0];
    if (!f) return;
    const d = describe(f);
    useArgusStore.getState().setHovered({
      x: e.point.x,
      y: e.point.y,
      title: d.title,
      rows: d.rows,
      color: d.color,
      hint: "click for details",
    });
  });
  map.on("mouseleave", renderLayerId, () => {
    map.getCanvas().style.cursor = "";
    useArgusStore.getState().setHovered(null);
  });
  map.on("click", renderLayerId, (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    useArgusStore.getState().setSelected({ layerId: layerKey, ...describe(f) });
  });
}
