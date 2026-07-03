import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";
import { coverageTiles, type Tile } from "@/src/core/tiles";

// Live aircraft, MULTI-SOURCE. Three keyless ADS-B aggregators share the same
// per-aircraft schema (ADSB-Exchange lineage). Two request modes:
//   • point  ?lat&lon&dist        — one radius query (the agent's query surface)
//   • bbox   ?west&south&east&north — TILED to cover a whole country/state
// A single 250nm radius only covers a country's centre, so bbox mode grids the
// area into overlapping tiles and merges by hex — this is what makes the layer
// actually populate for large countries. adsb.lol (no politeness gap) fetches
// every tile; the two rate-limited sources enrich the first tile only, so we get
// multi-source provenance without hammering them once per tile.
const MAX_DIST_NM = 250;
const SOFT_MS = 3_000;

interface RawAircraft {
  hex: string;
  flight?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  true_heading?: number;
  dbFlags?: number;
}

interface Source {
  id: string;
  url: (lat: number, lon: number, dist: number) => string;
  field: "ac" | "aircraft";
  minGapMs?: number;
}

const SOURCES: Source[] = [
  { id: "adsb.lol", url: (la, lo, d) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${d}`, field: "ac" },
  { id: "airplanes.live", url: (la, lo, d) => `https://api.airplanes.live/v2/point/${la}/${lo}/${d}`, field: "ac", minGapMs: 1_000 },
  { id: "adsb.fi", url: (la, lo, d) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${d}`, field: "aircraft", minGapMs: 1_000 },
];
const PRIMARY = SOURCES[0]; // adsb.lol — fetches every tile
const EXTRA = SOURCES.slice(1); // rate-limited — first tile only, for provenance

const SLOW = Symbol("slow");

/** One source × one tile → aircraft array (or [] on failure or past deadline). */
async function fetchTile(s: Source, t: Tile, deadline: Promise<typeof SLOW>): Promise<RawAircraft[]> {
  const run = (async () => {
    const res = await upstreamFetch(s.url(t.lat, t.lon, t.dist), { timeoutMs: 6_000, minGapMs: s.minGapMs });
    if (!res.ok) throw new Error(`${s.id} ${res.status}`);
    const data = (await res.json()) as Record<string, RawAircraft[] | undefined>;
    return Array.isArray(data[s.field]) ? data[s.field]! : [];
  })();
  const v = await Promise.race([run.catch(() => SLOW), deadline]);
  return Array.isArray(v) ? v : [];
}

export async function GET(req: Request) {
  const { searchParams: q } = new URL(req.url);
  const num = (k: string) => Number(q.get(k));

  // Build the tile list from whichever mode was requested.
  let tiles: Tile[] | null;
  const hasBbox = ["west", "south", "east", "north"].every((k) => Number.isFinite(num(k)));
  if (hasBbox) {
    tiles = coverageTiles({ west: num("west"), south: num("south"), east: num("east"), north: num("north") });
    if (tiles === null) return Response.json({ tooBig: true }, { status: 200 });
  } else {
    const lat = num("lat"), lon = num("lon");
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "lat/lon or bbox required" }, { status: 400 });
    }
    const dist = Math.min(MAX_DIST_NM, Math.max(1, num("dist") || 100));
    tiles = [{ lat, lon, dist }];
  }

  // adsb.lol over every tile + the extras on tile[0]. Soft per-request deadline:
  // whatever arrived by SOFT_MS ships now; the client keeps its prior fleet 25s.
  const deadline = new Promise<typeof SLOW>((r) => setTimeout(() => r(SLOW), SOFT_MS));
  const jobs: Array<Promise<{ id: string; ac: RawAircraft[] }>> = [];
  for (const t of tiles) jobs.push(fetchTile(PRIMARY, t, deadline).then((ac) => ({ id: PRIMARY.id, ac })));
  for (const s of EXTRA) jobs.push(fetchTile(s, tiles[0], deadline).then((ac) => ({ id: s.id, ac })));
  const settled = await Promise.all(jobs);

  // Merge by hex; track which sources actually returned anything.
  const byHex = new Map<string, RawAircraft>();
  const answered = new Set<string>();
  for (const { id, ac } of settled) {
    if (ac.length) answered.add(id);
    for (const a of ac) {
      if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
      const key = a.hex || `${a.flight}-${a.lat}-${a.lon}`;
      if (!byHex.has(key)) byHex.set(key, a);
    }
  }
  if (answered.size === 0) {
    return Response.json({ error: "all aircraft sources failed" }, { status: 502 });
  }

  const features: Feature<Point>[] = [...byHex.values()].map((a) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [a.lon!, a.lat!] },
    properties: {
      hex: a.hex,
      flight: (a.flight ?? "").trim() || a.hex,
      craft: a.t ?? "",
      alt: a.alt_baro === "ground" ? 0 : (a.alt_baro ?? null),
      gs: a.gs ?? null,
      track: a.track ?? a.true_heading ?? 0,
      mil: (a.dbFlags ?? 0) & 1 ? 1 : 0,
    },
  }));

  return Response.json(
    { type: "FeatureCollection", features } as FeatureCollection<Point>,
    {
      headers: {
        "Cache-Control": "s-maxage=10, stale-while-revalidate=20",
        "X-Argus-Sources": [...answered].join(","),
      },
    },
  );
}
