import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { SelShape } from "@/src/store/useArgusStore";

// Bundled admin-1 (states / provinces) — Natural Earth 10m, props stripped to
// {name,admin,id} and geometry simplified (~0.04°). Lazy-loaded once (like
// countries.geojson) so the FIRST hover/select at state zoom is instant instead
// of waiting on a Nominatim reverse. County/city stay on-demand (resolve.ts).

interface StateRec {
  name: string;
  id: string;
  geometry: Polygon | MultiPolygon;
  bbox: [number, number, number, number]; // [w,s,e,n]
}

let recs: StateRec[] | null = null;
let loading: Promise<void> | null = null;

function bboxOf(g: Polygon | MultiPolygon): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  const scan = (ring: number[][]) => {
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  };
  if (g.type === "Polygon") g.coordinates.forEach((r) => scan(r as number[][]));
  else g.coordinates.forEach((poly) => poly.forEach((r) => scan(r as number[][])));
  return [w, s, e, n];
}

/** Load + index the bundled states once. Safe to call repeatedly. */
export function loadStates(): Promise<void> {
  if (recs) return Promise.resolve();
  if (!loading) {
    loading = fetch("/states.geojson")
      .then((r) => r.json() as Promise<FeatureCollection>)
      .then((fc) => {
        recs = [];
        for (const f of fc.features) {
          const g = f.geometry;
          if (g?.type !== "Polygon" && g?.type !== "MultiPolygon") continue;
          const p = (f.properties ?? {}) as Record<string, unknown>;
          recs.push({
            name: String(p.name ?? "?"),
            id: String(p.id ?? p.name ?? "?"),
            geometry: g as Polygon | MultiPolygon,
            bbox: bboxOf(g as Polygon | MultiPolygon),
          });
        }
      })
      .catch(() => { recs = []; }); // network fail → empty; callers fall back to Nominatim
  }
  return loading;
}

// standard ray-casting point-in-ring (outer rings only — good enough for hit-test)
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The admin-1 shape under a point, from bundled data. A bbox pre-filter keeps
 * this cheap enough to call on every mousemove. Returns:
 *   undefined — states not loaded yet (caller should fall back / wait)
 *   null      — loaded, but no state covers the point (ocean / unmapped micro-state)
 *   SelShape  — the state
 */
export function stateAtPoint(lon: number, lat: number): SelShape | null | undefined {
  if (!recs) {
    void loadStates();
    return undefined;
  }
  for (const r of recs) {
    const [w, s, e, n] = r.bbox;
    if (lat < s || lat > n || lon < w || lon > e) continue; // cheap reject
    const g = r.geometry;
    const hit =
      g.type === "Polygon"
        ? pointInRing(lon, lat, g.coordinates[0] as number[][])
        : g.coordinates.some((poly) => pointInRing(lon, lat, poly[0] as number[][]));
    if (hit) return { id: `admin:${r.id}`, kind: "admin", label: r.name, geometry: g, ref: r.name };
  }
  return null;
}
