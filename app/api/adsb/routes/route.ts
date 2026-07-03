import { upstreamJson } from "@/src/core/upstream";

// Keyless flight-route enrichment. ADS-B position feeds carry only a callsign,
// so to know a flight is "related to India" (origin/dest = India) we resolve
// callsign → route → airport countries via hexdb.io (free, no key):
//   GET /api/v1/route/icao/{callsign}  → { route: "VABB-KEWR" }  (origin-dest ICAO)
//   GET /api/v1/airport/icao/{icao}    → { country_code, latitude, longitude }
// Routes are stable for a day, airports are effectively immutable, so both are
// cached hard in module scope — after warm-up most polls resolve with zero
// upstream calls. A cold batch is capped so we never storm hexdb at once.
export const dynamic = "force-dynamic";

const HEX = "https://hexdb.io/api/v1";
const ROUTE_TTL = 6 * 3600_000; // 6h — a callsign's route rarely changes intraday
const NEG_TTL = 30 * 60_000; // 30min — don't re-ask for callsigns hexdb can't route
const MAX_NEW = 40; // cold-start lookups per request; rest fill on later polls
const GAP = 120; // ms between hexdb calls (politeness to a small free service)

interface Airport {
  c: string; // ISO2 country
  lat: number;
  lon: number;
}
interface RouteEnds {
  o?: Airport; // origin
  d?: Airport; // destination
}

const airportCache = new Map<string, Airport | null>(); // ICAO → airport | null (unknown)
const routeCache = new Map<string, { ends: RouteEnds; at: number }>();

async function lookupAirport(icao: string): Promise<Airport | null> {
  if (airportCache.has(icao)) return airportCache.get(icao)!;
  try {
    const a = await upstreamJson<{ country_code?: string; latitude?: number; longitude?: number }>(
      `${HEX}/airport/icao/${encodeURIComponent(icao)}`,
      { timeoutMs: 6_000, minGapMs: GAP },
    );
    const c = String(a.country_code ?? "").toUpperCase();
    const airport: Airport | null =
      /^[A-Z]{2}$/.test(c) && typeof a.latitude === "number" && typeof a.longitude === "number"
        ? { c, lat: a.latitude, lon: a.longitude }
        : null;
    airportCache.set(icao, airport);
    return airport;
  } catch {
    return null; // transient — don't poison the cache, retry next time
  }
}

async function lookupRoute(callsign: string): Promise<RouteEnds> {
  const cached = routeCache.get(callsign);
  if (cached && Date.now() - cached.at < (Object.keys(cached.ends).length ? ROUTE_TTL : NEG_TTL)) {
    return cached.ends;
  }
  let ends: RouteEnds = {};
  try {
    const r = await upstreamJson<{ route?: string }>(
      `${HEX}/route/icao/${encodeURIComponent(callsign)}`,
      { timeoutMs: 6_000, minGapMs: GAP },
    );
    const legs = String(r.route ?? "")
      .split("-")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (legs.length >= 2) {
      const [o, d] = await Promise.all([lookupAirport(legs[0]), lookupAirport(legs[legs.length - 1])]);
      ends = { o: o ?? undefined, d: d ?? undefined };
    }
  } catch {
    ends = {};
  }
  routeCache.set(callsign, { ends, at: Date.now() });
  return ends;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const callsigns = (searchParams.get("callsigns") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!callsigns.length) return Response.json({ routes: {} });

  const routes: Record<string, RouteEnds> = {};
  let budget = MAX_NEW;
  for (const cs of callsigns) {
    const fresh = routeCache.get(cs);
    const isCached =
      fresh && Date.now() - fresh.at < (Object.keys(fresh.ends).length ? ROUTE_TTL : NEG_TTL);
    if (!isCached && budget <= 0) continue; // defer cold lookups to a later poll
    if (!isCached) budget--;
    routes[cs] = await lookupRoute(cs);
  }

  return Response.json(
    { routes },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } },
  );
}
