import type { Geometry, Polygon, MultiPolygon } from "geojson";

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Walk every [lng,lat] pair in any (non-collection) geometry. */
export function eachCoord(geom: Geometry, cb: (lng: number, lat: number) => void): void {
  if (geom.type === "GeometryCollection") {
    for (const g of geom.geometries) eachCoord(g, cb);
    return;
  }
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") cb(c[0] as number, c[1] as number);
    else for (const x of c) walk(x);
  };
  walk((geom as { coordinates: unknown }).coordinates);
}

/**
 * Antimeridian-aware bbox of one or more geometries. Compares the naive
 * min/max longitude span against the span computed in a 0..360 domain and
 * keeps whichever is tighter. When the shape genuinely wraps the ±180 line the
 * returned bbox has `west > east` (the wrap convention consumers must honor);
 * this fixes Russia/USA/Fiji/NZ collapsing to a globe-spanning box.
 */
export function geometryBbox(geoms: Geometry | Geometry[]): Bbox | null {
  const list = Array.isArray(geoms) ? geoms : [geoms];
  const lngs: number[] = [];
  let south = 90,
    north = -90,
    seen = false;
  for (const g of list) {
    eachCoord(g, (lng, lat) => {
      seen = true;
      lngs.push(lng);
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    });
  }
  if (!seen) return null;
  let nW = 180,
    nE = -180; // naive
  let sW = 360,
    sE = 0; // shifted to 0..360
  for (const lng of lngs) {
    if (lng < nW) nW = lng;
    if (lng > nE) nE = lng;
    const s = lng < 0 ? lng + 360 : lng;
    if (s < sW) sW = s;
    if (s > sE) sE = s;
  }
  const naiveSpan = nE - nW;
  const shiftSpan = sE - sW;
  if (shiftSpan < naiveSpan) {
    // wraps the antimeridian — express east in [-180,180], west may be > east
    const west = sW > 180 ? sW - 360 : sW;
    const east = sE > 180 ? sE - 360 : sE;
    return { west, south, east, north };
  }
  return { west: nW, south, east: nE, north };
}

/** True when a bbox wraps the antimeridian (west > east by convention). */
export function bboxWraps(b: Bbox): boolean {
  return b.west > b.east;
}

/**
 * Camera-framing bbox for a single entity: the bbox of its LARGEST polygon.
 * Fixes countries with scattered overseas territories (France, USA, UK) — the
 * whole territory stays highlighted/dimmed, but the camera frames the mainland
 * instead of the entire globe. For a plain Polygon it's just the bbox.
 */
export function primaryBbox(geom: Geometry): Bbox | null {
  const main = mainlandPolygon(geom);
  return main ? geometryBbox(main) : geometryBbox(geom);
}

/**
 * The single largest polygon of a shape (the mainland) as a Polygon. Used so
 * the highlight/dim shows only the main landmass, not scattered overseas
 * territories. A plain Polygon is returned unchanged.
 */
export function mainlandPolygon(geom: Geometry): Polygon | null {
  if (geom.type === "Polygon") return geom;
  if (geom.type !== "MultiPolygon") return null;
  let best: Polygon | null = null;
  let bestArea = -1;
  for (const poly of geom.coordinates) {
    const b = geometryBbox({ type: "Polygon", coordinates: poly });
    if (!b) continue;
    const lon = (bboxWraps(b) ? b.east + 360 : b.east) - b.west;
    const area = lon * (b.north - b.south);
    if (area > bestArea) {
      bestArea = area;
      best = { type: "Polygon", coordinates: poly };
    }
  }
  return best;
}

/** Clamp to valid lon/lat so upstream APIs don't 400 on a wrapped globe view. */
export function clampBbox(b: Bbox): Bbox {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
  return {
    west: clamp(b.west, -180, 180),
    east: clamp(b.east, -180, 180),
    south: clamp(b.south, -90, 90),
    north: clamp(b.north, -90, 90),
  };
}

/**
 * Snap a bbox to a coarse grid so that small pans/zooms resolve to the SAME
 * key — this is what lets the cache turn re-visiting an area into zero network.
 */
export function quantizeBbox(b: Bbox, precision = 1): Bbox {
  const q = (v: number) => Math.round(v / precision) * precision;
  return { west: q(b.west), south: q(b.south), east: q(b.east), north: q(b.north) };
}

export function bboxKey(b: Bbox, precision = 1): string {
  const q = quantizeBbox(b, precision);
  return `${q.west},${q.south},${q.east},${q.north}`;
}

export function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return (
    outer.west <= inner.west &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.north >= inner.north
  );
}

/** True if two bboxes overlap at all — used to pick which feeds cover the AOI. */
export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

export function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    west: Math.min(a.west, b.west),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    north: Math.max(a.north, b.north),
  };
}

/** Expand a bbox to include "nearby" surroundings (antimeridian-aware). */
export function bufferBbox(b: Bbox, frac = 0.15, minDeg = 1): Bbox {
  const lonSpan = bboxWraps(b) ? b.east + 360 - b.west : b.east - b.west;
  const dx = Math.max(lonSpan * frac, minDeg);
  const dy = Math.max((b.north - b.south) * frac, minDeg);
  // near-global bbox: padding would wrap BOTH edges and invert the box into its
  // own complement (a world view becoming "Pacific only") — clamp to full world
  if (lonSpan + 2 * dx >= 360) {
    return {
      west: -180,
      south: Math.max(-90, b.south - dy),
      east: 180,
      north: Math.min(90, b.north + dy),
    };
  }
  const west = b.west - dx;
  const east = b.east + dx;
  return {
    west: west < -180 ? west + 360 : west,
    south: Math.max(-90, b.south - dy),
    east: east > 180 ? east - 360 : east,
    north: Math.min(90, b.north + dy),
  };
}

export function pointInBbox(lng: number, lat: number, b: Bbox): boolean {
  // west > east = antimeridian wrap (e.g. a Europe AOI that includes Russia)
  const inLon = b.west <= b.east ? lng >= b.west && lng <= b.east : lng >= b.west || lng <= b.east;
  return inLon && lat >= b.south && lat <= b.north;
}

/**
 * The bbox a street layer should fetch: the buffered AOI when one is set, else the
 * current viewport (for AOI-free "just zoom in and see the streets" browsing).
 * Returns null when neither is available (nothing to load).
 */
export function fetchBbox(aoi: Bbox | null, viewport: Bbox | null): Bbox | null {
  if (aoi) return bufferBbox(aoi);
  return viewport ?? null;
}

// ── Point-in-polygon (for filtering features to a region's REAL shape, not its
// rectangular bbox — a country's bbox drags in oceans and neighbours). ──────────

/** Ray-casting test against one linear ring. */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** True if the point is inside the Polygon/MultiPolygon (holes respected). */
export function pointInGeometry(lng: number, lat: number, geom: Polygon | MultiPolygon): boolean {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (!pointInRing(lng, lat, poly[0])) continue; // outside outer ring
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lng, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Squared distance (deg²) from a point to a segment. */
function distSqToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** Approx great-circle-agnostic degree distance from a point to the geometry's
 *  outer boundary (0 if inside). Cheap enough for a modest "nearby" margin test. */
export function distToGeometryDeg(lng: number, lat: number, geom: Polygon | MultiPolygon): number {
  if (pointInGeometry(lng, lat, geom)) return 0;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = Infinity;
  for (const poly of polys) {
    const ring = poly[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = distSqToSeg(lng, lat, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
