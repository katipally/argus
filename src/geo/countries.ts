import type { FeatureCollection } from "geojson";
import { type Bbox, unionBbox } from "@/src/core/bbox";

export interface CountryInfo {
  name: string; // dataset NAME — used as the selection identity + highlight key
  continent: string;
  bbox: Bbox;
  iso2?: string; // ISO_A2 — used to match AIS ship destinations (LOCODE prefix)
}

interface CountriesData {
  list: CountryInfo[];
  fc: FeatureCollection;
}

let cache: CountriesData | null = null;
let loading: Promise<CountriesData> | null = null;

function eachPos(coords: unknown, cb: (x: number, y: number) => void): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number") {
    cb(coords[0] as number, coords[1] as number);
  } else {
    for (const c of coords) eachPos(c, cb);
  }
}

function geomBbox(geometry: FeatureCollection["features"][number]["geometry"]): Bbox | null {
  if (!geometry || !("coordinates" in geometry)) return null;
  let west = 180,
    south = 90,
    east = -180,
    north = -90,
    seen = false;
  eachPos(geometry.coordinates, (x, y) => {
    seen = true;
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  });
  return seen ? { west, south, east, north } : null;
}

/** Load + index the bundled world countries GeoJSON (once). */
export async function loadCountries(): Promise<CountriesData> {
  if (cache) return cache;
  if (!loading) {
    loading = fetch("/countries.geojson")
      .then((r) => r.json() as Promise<FeatureCollection>)
      .then((fc) => {
        const list: CountryInfo[] = [];
        for (const f of fc.features) {
          const p = (f.properties ?? {}) as Record<string, unknown>;
          const bbox = geomBbox(f.geometry);
          if (!bbox) continue;
          const iso2 = String(p.ISO_A2 ?? "").toUpperCase();
          list.push({
            name: String(p.NAME ?? p.ADMIN ?? "?"),
            continent: String(p.CONTINENT ?? ""),
            bbox,
            iso2: /^[A-Z]{2}$/.test(iso2) ? iso2 : undefined,
          });
        }
        list.sort((a, b) => a.name.localeCompare(b.name));
        cache = { list, fc };
        return cache;
      });
  }
  return loading;
}

/** ISO_A2 for a dataset country NAME, from the already-loaded cache (sync).
 *  Returns undefined until loadCountries() has resolved — callers treat a miss
 *  as "no destination match this round", which self-heals once loaded. */
export function iso2ForName(name: string): string | undefined {
  if (!cache) return undefined;
  const n = name.trim().toLowerCase();
  return cache.list.find((c) => c.name.toLowerCase() === n)?.iso2;
}

export function unionOf(bboxes: Bbox[]): Bbox | null {
  if (!bboxes.length) return null;
  return bboxes.reduce((acc, b) => unionBbox(acc, b));
}

// ── point-in-country hit testing (for click-to-select) ───────────────────────
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The bundled country feature containing a point (outer rings only). */
export async function featureAtPoint(
  lon: number,
  lat: number,
): Promise<{ name: string; continent: string; geometry: import("geojson").Polygon | import("geojson").MultiPolygon } | null> {
  const { fc } = await loadCountries();
  for (const f of fc.features) {
    const g = f.geometry;
    if (g?.type === "Polygon") {
      if (pointInRing(lon, lat, g.coordinates[0] as number[][]))
        return mk(f, g as import("geojson").Polygon);
    } else if (g?.type === "MultiPolygon") {
      for (const poly of g.coordinates) {
        if (pointInRing(lon, lat, poly[0] as number[][])) return mk(f, g as import("geojson").MultiPolygon);
      }
    }
  }
  return null;
  function mk(f: FeatureCollection["features"][number], geometry: import("geojson").Polygon | import("geojson").MultiPolygon) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    return { name: String(p.NAME ?? p.ADMIN ?? "?"), continent: String(p.CONTINENT ?? ""), geometry };
  }
}
