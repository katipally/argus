import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { Feature, Polygon, Position } from "geojson";
import { useArgusStore, type SelShape } from "@/src/store/useArgusStore";
import { mainlandPolygon } from "@/src/core/bbox";

// Focus hard-clip: dim everything OUTSIDE the selected shapes so only the
// focus reads. Inverse polygon — a world rectangle with every selected shape's
// outer ring(s) punched out as holes. Driven by `selection` (the same real
// geometry the highlight uses), so the dim and the outline always agree.

const SRC = "focus-mask-src";
const FILL = "focus-mask-fill";
// Slightly inside the poles so the globe's caps still dim.
const WORLD: Position[] = [
  [-180, -89.9], [180, -89.9], [180, 89.9], [-180, 89.9], [-180, -89.9],
];

let mapRef: MlMap | null = null;

/** Outer ring(s) to punch out for each selected shape (EEZ never dims). */
function holes(shapes: SelShape[]): Position[][] {
  const out: Position[][] = [];
  for (const s of shapes) {
    if (s.kind === "eez") continue; // the water zone is only a dotted hint, not a dim cutout
    // Countries/admin/places dim only their mainland; continents/oceans/boxes
    // dim their full extent (all polygons).
    if (s.kind === "country" || s.kind === "admin" || s.kind === "place") {
      const main = mainlandPolygon(s.geometry);
      if (main) out.push(main.coordinates[0] as Position[]);
    } else if (s.geometry.type === "Polygon") {
      out.push(s.geometry.coordinates[0] as Position[]);
    } else {
      for (const poly of s.geometry.coordinates) out.push(poly[0] as Position[]);
    }
  }
  return out;
}

const DIM = 0.45;

function apply(shapes: SelShape[]): void {
  const src = mapRef?.getSource(SRC) as GeoJSONSource | undefined;
  if (!src || !mapRef) return;
  if (!shapes.length) {
    // fade out over the old geometry instead of snapping to clear
    mapRef.setPaintProperty(FILL, "fill-opacity", 0);
    return;
  }
  const mask: Feature<Polygon> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [WORLD, ...holes(shapes)] },
  };
  src.setData({ type: "FeatureCollection", features: [mask] });
  mapRef.setPaintProperty(FILL, "fill-opacity", DIM);
}

export function initFocusMask(map: MlMap): void {
  mapRef = map;
  map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // sit above basemap/satellite but below the first Argus data layer
  const style = map.getStyle();
  const beforeId = style.layers?.find((l) => (l as { source?: string }).source === "countries-src")?.id;
  map.addLayer(
    {
      id: FILL,
      type: "fill",
      source: SRC,
      // soft dim, faded in/out over 450ms so selecting never flashes the eyes
      paint: {
        "fill-color": "#02040a",
        "fill-opacity": 0,
        "fill-opacity-transition": { duration: 450, delay: 0 },
      },
    },
    beforeId,
  );
  useArgusStore.subscribe((s, p) => {
    if (s.selection !== p.selection) apply(s.selection);
  });
  apply(useArgusStore.getState().selection);
}
