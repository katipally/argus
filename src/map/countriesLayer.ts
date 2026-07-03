import type {
  Map as MlMap,
  MapLayerMouseEvent,
  GeoJSONSource,
} from "maplibre-gl";
import type { Feature, Polygon, MultiPolygon, GeoJSON } from "geojson";
import { useArgusStore, type SelShape } from "@/src/store/useArgusStore";
import { loadCountries } from "@/src/geo/countries";
import { continentShape, resolveAtPoint } from "@/src/geo/resolve";
import { loadStates, stateAtPoint } from "@/src/geo/states";
import { mainlandPolygon } from "@/src/core/bbox";

// Country boundaries on the map:
//  • countries-src  — the bundled world polygons, used for hover hit-testing.
//  • selection-src  — every selected shape's REAL geometry (fill + outline). The
//    focus mask reads the SAME shapes, so highlight and dimming can never
//    disagree (the old bug: rectangles vs. real borders).
//  • hover-src      — a live filled-glow preview of what a right-click WOULD
//    select. Continent (<z2.7) and country (<z4.5) come from bundled geometry
//    (instant); deeper (state/county/city) resolve through the SAME
//    resolveAtPoint the click uses, debounced on mouse-pause — so the glow is
//    always exactly the shape you'll grab.
const SRC = "countries-src";
const FILL = "countries-fill";
const SEL_SRC = "selection-src";
const SEL_FILL = "selection-fill";
const SEL_LINE = "selection-line";
const HOV_SRC = "hover-src";
const HOV_FILL = "hover-fill";
const HOV_LINE = "hover-line";

let mapRef: MlMap | null = null;
let lastHoverKey: string | null = null;
// deep-hover debounce + stale-guard: only the newest resolve is allowed to draw
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let hoverToken = 0;
// grid cell (deg) the deep-hover point snaps to, so nearby hovers hit the cache
const HOVER_GRID = 0.05;

function geomOf(f: Feature): Polygon | MultiPolygon | null {
  const g = f.geometry;
  return g?.type === "Polygon" || g?.type === "MultiPolygon" ? g : null;
}

// continents are unions of many countries — build once per continent, cache
const continentGeoms = new Map<string, Polygon | MultiPolygon | null>();
async function continentGeom(continent: string): Promise<Polygon | MultiPolygon | null> {
  if (continentGeoms.has(continent)) return continentGeoms.get(continent)!;
  const shape = await continentShape(continent, continent);
  continentGeoms.set(continent, shape?.geometry ?? null);
  return shape?.geometry ?? null;
}

/** The admin level a right-click resolves at this zoom (resolve.ts bands). */
function deepLevel(zoom: number): string {
  return zoom < 6.5 ? "state" : zoom < 9 ? "county" : "city";
}

export async function initCountries(map: MlMap): Promise<void> {
  mapRef = map;
  void loadStates(); // warm the admin-1 cache so state hover is instant on first zoom-in
  const { fc } = await loadCountries();
  if (map.getSource(SRC)) return;
  map.addSource(SRC, { type: "geojson", data: fc });

  // selected shapes (real geometry). Land = solid outline + light fill (mainland
  // only); EEZ = dotted outline, no fill (just so the user knows it's there).
  map.addSource(SEL_SRC, { type: "geojson", data: empty() });
  map.addLayer({
    id: SEL_FILL,
    type: "fill",
    source: SEL_SRC,
    filter: ["!=", ["get", "eez"], true],
    paint: { "fill-color": "#38e0ff", "fill-opacity": 0.1 },
  });
  map.addLayer({
    id: SEL_LINE,
    type: "line",
    source: SEL_SRC,
    filter: ["!=", ["get", "eez"], true],
    paint: { "line-color": "#38e0ff", "line-width": 1.8, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "selection-eez-line",
    type: "line",
    source: SEL_SRC,
    filter: ["==", ["get", "eez"], true],
    paint: { "line-color": "#7dd3fc", "line-width": 1.2, "line-opacity": 0.8, "line-dasharray": [2, 2] },
  });

  // hover preview — a distinct GREY DASHED "ghost", visually separate from the
  // solid-cyan SELECTION so the two never read as the same thing. The fill only
  // renders for reasonably-sized regions (state/county/city): filling a whole
  // country/continent on the globe clips into an ugly straight-edged blob, so
  // those show OUTLINE only (feature carries `big:true`).
  map.addSource(HOV_SRC, { type: "geojson", data: empty() });
  map.addLayer({
    id: HOV_FILL,
    type: "fill",
    source: HOV_SRC,
    filter: ["!=", ["get", "big"], true],
    paint: { "fill-color": "#aab4c0", "fill-opacity": 0.09 },
  });
  map.addLayer({
    id: HOV_LINE,
    type: "line",
    source: HOV_SRC,
    paint: {
      "line-color": "#aab4c0",
      "line-width": 1.4,
      "line-opacity": 0.85,
      "line-dasharray": [2, 2],
    },
  });

  // transparent pickable fill (hit-testing only)
  map.addLayer({
    id: FILL,
    type: "fill",
    source: SRC,
    paint: { "fill-color": "#000000", "fill-opacity": 0 },
  });

  map.on("mousemove", FILL, (e: MapLayerMouseEvent) => {
    const store = useArgusStore.getState();
    // entity tooltips (data dots) take priority over the selection hint
    if (store.hovered) {
      if (store.hoverHint) store.setHoverHint(null);
      return;
    }
    const zoom = map.getZoom();
    const f = e.features?.[0];
    const name = f?.properties?.NAME ? String(f.properties.NAME) : null;
    const px = e.point.x, py = e.point.y;
    const { lat, lng } = e.lngLat;

    // INSTANT bands — continent (<z2.7) / country (<z4.5) from bundled geometry.
    // Outline-only (big=true): a whole country/continent fill clips badly on the
    // globe (that was the "random shape" bug).
    if (zoom < 4.5 && name) {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      const continent = zoom < 2.7 ? String(f?.properties?.CONTINENT ?? "") : null;
      const key = continent || name;
      store.setHoverHint({ x: px, y: py, text: `${key} · right-click` });
      if (key === lastHoverKey) return; // only redraw when the target changes
      lastHoverKey = key;
      const tok = ++hoverToken;
      if (continent) {
        void continentGeom(continent).then((g) => { if (hoverToken === tok) setHoverGeom(g, true); });
      } else {
        setHoverGeom((f && geomOf(f as unknown as Feature)) ?? null, true);
      }
      return;
    }

    // STATE band (z4.5–6.5) — bundled admin-1, INSTANT point-in-poly, no network,
    // no debounce. `stateAtPoint` returns undefined until the file has loaded;
    // until then we fall through to the debounced Nominatim path just this once.
    if (zoom < 6.5) {
      const s = stateAtPoint(lng, lat);
      if (s !== undefined) {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        const key = s ? s.id : "no-state";
        store.setHoverHint({ x: px, y: py, text: s ? `${s.label} · right-click` : "right-click · select state" });
        if (key === lastHoverKey) return;
        lastHoverKey = key;
        hoverToken++;
        setHoverGeom(s ? s.geometry : null, false);
        return;
      }
    }

    // DEEP bands — county/city via Nominatim (state only when not yet bundled).
    // Two smoothness tricks:
    //  1. Snap the point to a ~0.05° grid so scanning within a region reuses the
    //     cached boundary (resolve.ts caches by coord; raw coords never repeat).
    //  2. Show a calm hint immediately — NO "resolving…" flash — and just fill
    //     the boundary in when it arrives after the pause.
    const level = deepLevel(zoom);
    const glat = Math.round(e.lngLat.lat / HOVER_GRID) * HOVER_GRID;
    const glng = Math.round(e.lngLat.lng / HOVER_GRID) * HOVER_GRID;
    const gkey = `${level}@${glat.toFixed(2)},${glng.toFixed(2)}`;
    store.setHoverHint({ x: px, y: py, text: `right-click · select ${level}` });
    if (gkey === lastHoverKey) return; // same grid cell — keep what's drawn
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      lastHoverKey = gkey;
      const tok = ++hoverToken;
      void resolveAtPoint(glat, glng, zoom).then((shape) => {
        if (hoverToken !== tok) return; // a newer hover superseded this one
        const cur = useArgusStore.getState();
        if (cur.hovered) return; // a data dot grabbed focus meanwhile
        if (shape) {
          setHoverGeom(shape.geometry, false);
          cur.setHoverHint({ x: px, y: py, text: `${shape.label} · right-click` });
        } else {
          setHoverGeom(null);
        }
      });
    }, 350);
  });
  map.on("mouseleave", FILL, () => {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverToken++; // invalidate any in-flight resolve
    lastHoverKey = null;
    setHoverGeom(null);
    useArgusStore.getState().setHoverHint(null);
  });

  // keep the selected-outline layer in sync with the store's selection
  useArgusStore.subscribe((s, p) => {
    if (s.selection !== p.selection) setSelectionShapes(s.selection);
  });
  setSelectionShapes(useArgusStore.getState().selection);
}

function empty(): GeoJSON {
  return { type: "FeatureCollection", features: [] };
}

/** Draw selected shapes: mainland-only for land, full geometry (dotted) for EEZ. */
export function setSelectionShapes(shapes: SelShape[]): void {
  const src = mapRef?.getSource(SEL_SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const features: Feature[] = [];
  for (const s of shapes) {
    if (s.kind === "eez") {
      features.push({ type: "Feature", properties: { id: s.id, eez: true }, geometry: s.geometry });
    } else {
      // Countries/admin/places: mainland only (drop scattered overseas
      // territories). Continents/oceans/boxes keep their full geometry.
      const mainlandOnly = s.kind === "country" || s.kind === "admin" || s.kind === "place";
      const geom = mainlandOnly ? mainlandPolygon(s.geometry) ?? s.geometry : s.geometry;
      features.push({ type: "Feature", properties: { id: s.id, eez: false }, geometry: geom });
    }
  }
  src.setData({ type: "FeatureCollection", features });
}

/** Live hover-preview (null clears it). `big` = country/continent → outline only. */
export function setHoverGeom(geom: Polygon | MultiPolygon | null, big = false): void {
  const src = mapRef?.getSource(HOV_SRC) as GeoJSONSource | undefined;
  if (!src) return;
  src.setData(
    geom ? { type: "Feature", properties: { big }, geometry: geom } : empty(),
  );
}
