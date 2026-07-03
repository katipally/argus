import type { Polygon, MultiPolygon, Feature } from "geojson";
import type { SelShape } from "@/src/store/useArgusStore";
import { loadCountries, featureAtPoint } from "@/src/geo/countries";
import { loadStates, stateAtPoint } from "@/src/geo/states";
import { CONTINENTS, OCEANS, REGIONS, type Scope } from "@/src/geo/scopes";
import type { Bbox } from "@/src/core/bbox";

// Resolve a place to a selection shape carrying its REAL geometry. Countries and
// continents come from the bundled Natural Earth data (instant, offline);
// everything else (cities, districts, seas, arbitrary places) and EEZ resolve
// on-demand through /api/boundary (Nominatim / Marine Regions), cached in-module.

const cache = new Map<string, SelShape | null>();

function feat(f: Feature): Polygon | MultiPolygon | null {
  const g = f.geometry;
  if (g?.type === "Polygon" || g?.type === "MultiPolygon") return g;
  return null;
}

/** A country by dataset NAME, real border from countries.geojson. */
export async function countryShape(name: string): Promise<SelShape | null> {
  const { fc } = await loadCountries();
  const f = fc.features.find((x) => String(x.properties?.NAME) === name);
  const geometry = f && feat(f);
  if (!geometry) return null;
  return { id: `country:${name}`, kind: "country", label: name, geometry, ref: name };
}

/** A continent as the union (MultiPolygon) of its member countries' borders. */
export async function continentShape(continent: string, label: string): Promise<SelShape | null> {
  const { fc } = await loadCountries();
  const polys: MultiPolygon["coordinates"] = [];
  for (const f of fc.features) {
    if (String(f.properties?.CONTINENT) !== continent) continue;
    const g = feat(f);
    if (!g) continue;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else polys.push(...g.coordinates);
  }
  if (!polys.length) return null;
  return {
    id: `continent:${continent}`,
    kind: "continent",
    label,
    geometry: { type: "MultiPolygon", coordinates: polys },
    ref: continent,
  };
}

interface BoundaryResp {
  label?: string;
  displayName?: string;
  kind?: string;
  geometry?: Polygon | MultiPolygon;
  error?: string;
}

/** Resolve an arbitrary place (by name, osm id, or ground point) to a shape. */
export async function resolvePlace(opts: {
  name?: string;
  osmId?: string | number;
  osmType?: string;
  lat?: number;
  lon?: number;
  rzoom?: number;
  kind?: SelShape["kind"];
  label?: string;
}): Promise<SelShape | null> {
  const params = new URLSearchParams();
  if (opts.osmId && opts.osmType) {
    params.set("osmId", String(opts.osmId));
    params.set("osmType", opts.osmType);
  } else if (opts.lat != null && opts.lon != null) {
    params.set("lat", String(opts.lat));
    params.set("lon", String(opts.lon));
    if (opts.rzoom) params.set("rzoom", String(opts.rzoom));
  } else if (opts.name) {
    params.set("q", opts.name);
  } else return null;

  const key = `p:${params.toString()}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const r = await fetch(`/api/boundary?${params}`);
    if (!r.ok) {
      cache.set(key, null);
      return null;
    }
    const d = (await r.json()) as BoundaryResp;
    if (!d.geometry) {
      cache.set(key, null);
      return null;
    }
    const label = opts.label || d.label || opts.name || "Area";
    const shape: SelShape = {
      id: `place:${label}:${JSON.stringify(d.geometry.coordinates[0]?.[0] ?? "")}`.slice(0, 120),
      kind: opts.kind ?? "place",
      label,
      geometry: d.geometry,
      ref: opts.name ?? label,
    };
    cache.set(key, shape);
    return shape;
  } catch {
    cache.set(key, null);
    return null;
  }
}

// ── layered NAMED-place resolver (what the agent's set_area should use) ────────
// The point: a named place — country, state, city, sea, OR informal region — must
// come back as its REAL boundary, never a box at a coordinate. Order: bundled
// country/continent (instant, offline) → Nominatim polygon (states/cities/seas/
// most regions) → named-scope bbox (informal regions that only geocode to a
// point). Only a truly unknown string returns null.

const norm = (s: string) => s.trim().toLowerCase();

/** Common short names → Natural Earth dataset NAME (Nominatim handles the rest). */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "United States of America", us: "United States of America", "united states": "United States of America",
  uk: "United Kingdom", drc: "Dem. Rep. Congo", uae: "United Arab Emirates",
  russia: "Russia", "south korea": "South Korea", "north korea": "North Korea",
  "czech republic": "Czechia", burma: "Myanmar",
};

async function matchBundledCountry(q: string): Promise<SelShape | null> {
  const { fc } = await loadCountries();
  const target = norm(COUNTRY_ALIASES[norm(q)] ?? q);
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const names = [p.NAME, p.ADMIN, p.NAME_LONG, p.FORMAL_EN, p.BRK_NAME].filter(Boolean).map((x) => norm(String(x)));
    if (names.includes(target)) {
      const g = feat(f);
      if (g) return { id: `country:${p.NAME}`, kind: "country", label: String(p.NAME), geometry: g, ref: String(p.NAME) };
    }
  }
  return null;
}

const CONTINENT_NAMES = new Set(["africa", "europe", "asia", "north america", "south america", "oceania", "antarctica"]);

function scopeBoxShape(scope: Scope, kind: SelShape["kind"]): SelShape {
  const b: Bbox = scope.bbox;
  const ring: [number, number][] = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
  return { id: `scope:${scope.id}`, kind, label: scope.label, geometry: { type: "Polygon", coordinates: [ring] }, ref: scope.id };
}

/** Resolve a named place/region to a real-boundary shape (see block comment). */
export async function resolveArea(name: string): Promise<SelShape | null> {
  const q = name.trim();
  if (!q) return null;
  const country = await matchBundledCountry(q);
  if (country) return country;
  if (CONTINENT_NAMES.has(norm(q))) {
    const label = CONTINENTS.find((c) => norm(c.label) === norm(q))?.label ?? q;
    // Natural Earth CONTINENT field is Title Case ("North America") — match label.
    const cont = await continentShape(label, label);
    if (cont) return cont;
  }
  const nom = await resolvePlace({ name: q });
  if (nom) return nom;
  // last resort: an informal region/ocean Nominatim only points at → named bbox
  const ocean = OCEANS.find((s) => norm(s.label) === norm(q) || norm(s.id) === norm(q));
  if (ocean) return scopeBoxShape(ocean, "ocean");
  const region = [...REGIONS, ...CONTINENTS].find((s) => norm(s.label) === norm(q) || norm(s.id) === norm(q));
  if (region) return scopeBoxShape(region, "box");
  return null;
}

/**
 * Resolve the region under a clicked point at a level chosen by map zoom:
 * zoomed out → continent/country (instant, from bundled data); mid → state/
 * county; zoomed in → city/locality (Nominatim reverse). Gotham-style.
 */
export async function resolveAtPoint(lat: number, lon: number, mapZoom: number): Promise<SelShape | null> {
  if (mapZoom < 4.5) {
    const f = await featureAtPoint(lon, lat);
    if (f) {
      if (mapZoom < 2.7) return continentShape(f.continent, f.continent);
      return { id: `country:${f.name}`, kind: "country", label: f.name, geometry: f.geometry, ref: f.name };
    }
    // ocean / no landmass under the point → fall through to reverse
  }
  // STATE band: bundled admin-1 (instant, offline). Fall back to Nominatim only
  // where the bundled data has no state (oceans, a few micro-states).
  if (mapZoom < 6.5) {
    await loadStates();
    const s = stateAtPoint(lon, lat);
    if (s) return s;
  }
  const [rzoom, kind] =
    mapZoom < 6.5 ? [5, "admin" as const]
    : mapZoom < 9 ? [8, "admin" as const]
    : mapZoom < 11 ? [10, "place" as const]
    : [13, "place" as const];
  return resolvePlace({ lat, lon, rzoom, kind });
}

/** A country's EEZ (maritime control) polygon, on-demand. */
export async function eezShape(country: string): Promise<SelShape | null> {
  const key = `eez:${country}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const r = await fetch(`/api/boundary?eez=${encodeURIComponent(country)}`);
    if (!r.ok) {
      cache.set(key, null);
      return null;
    }
    const d = (await r.json()) as BoundaryResp;
    if (!d.geometry) {
      cache.set(key, null);
      return null;
    }
    const shape: SelShape = {
      id: `eez:${country}`,
      kind: "eez",
      label: `${country} EEZ`,
      geometry: d.geometry,
      ref: country,
    };
    cache.set(key, shape);
    return shape;
  } catch {
    cache.set(key, null);
    return null;
  }
}
