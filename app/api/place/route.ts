import { upstreamJson } from "@/src/core/upstream";

// "Right-click a place, learn about it" — aggregates keyless sources server-side
// (one polite request point for Wikimedia's rate limits):
//   • Nominatim reverse geocode → address (level follows the map zoom)
//   • Wikipedia GeoSearch → nearest article → REST summary (or a named article
//     when the client resolved a continent/country/ocean scope)
//   • Open-Meteo → current conditions
// `full=1` (the View-more workspace) adds:
//   • Wikidata → structured facts (population, area, elevation, website)
//   • Wikimedia Commons geosearch → photo gallery
//   • Overpass → notable nearby POIs (skipped at continent/ocean scope)
// Each source is independent (Promise.allSettled) so one failure never blanks
// the card. Cached an hour.
interface Nominatim {
  display_name?: string;
  address?: Record<string, string>;
}
interface GeoSearch {
  query?: { geosearch?: { title: string; pageid: number; dist: number }[] };
}
interface WikiSummary {
  title?: string;
  extract?: string;
  thumbnail?: { source: string };
  content_urls?: { desktop?: { page?: string } };
  wikibase_item?: string;
}
interface OpenMeteo {
  current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
}
interface CommonsQuery {
  query?: { pages?: Record<string, { title?: string; imageinfo?: { thumburl?: string; url?: string }[] }> };
}
interface WdClaim {
  mainsnak?: { datavalue?: { value?: { amount?: string } | string } };
}
interface WdEntity {
  entities?: Record<string, { claims?: Record<string, WdClaim[]> }>;
}
interface OverpassResp {
  elements?: { tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }[];
}

const WMO: Record<number, string> = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Severe thunderstorm",
};

/** Map the client map-zoom to a Nominatim reverse level (selection bands). */
function rzoomFor(zoom: number): number {
  if (zoom < 6.5) return 5; // state
  if (zoom < 9) return 8; // county
  if (zoom < 11) return 10; // city
  return 12; // district
}

function wdAmount(claims: Record<string, WdClaim[]> | undefined, prop: string): number | null {
  const v = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
  if (v && typeof v === "object" && "amount" in v) {
    const n = Number(v.amount);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function wikidataFacts(qid: string): Promise<Record<string, string>> {
  const d = await upstreamJson<WdEntity>(
    `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`,
    { timeoutMs: 8000 },
  );
  const claims = d.entities?.[qid]?.claims;
  const facts: Record<string, string> = {};
  const pop = wdAmount(claims, "P1082");
  if (pop != null) facts.population = Math.round(pop).toLocaleString("en-US");
  const area = wdAmount(claims, "P2046");
  if (area != null) facts.area = `${area.toLocaleString("en-US")} km²`;
  const elev = wdAmount(claims, "P2044");
  if (elev != null) facts.elevation = `${Math.round(elev)} m`;
  const site = claims?.P856?.[0]?.mainsnak?.datavalue?.value;
  if (typeof site === "string") facts.website = site;
  return facts;
}

async function commonsGallery(lat: number, lon: number): Promise<{ url: string; title: string }[]> {
  const d = await upstreamJson<CommonsQuery>(
    `https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${lat}%7C${lon}&ggsradius=10000&ggslimit=12&ggsnamespace=6&prop=imageinfo&iiprop=url&iiurlwidth=480&format=json&origin=*`,
    { timeoutMs: 9000 },
  );
  const out: { url: string; title: string }[] = [];
  for (const p of Object.values(d.query?.pages ?? {})) {
    const ii = p.imageinfo?.[0];
    if (ii?.thumburl) out.push({ url: ii.thumburl, title: (p.title ?? "").replace(/^File:/, "") });
  }
  return out;
}

async function nearbyPois(lat: number, lon: number): Promise<{ name: string; kind: string }[]> {
  const q = `[out:json][timeout:8];(
    node(around:20000,${lat},${lon})[aeroway=aerodrome][name];
    node(around:5000,${lat},${lon})[amenity=hospital][name];
    node(around:5000,${lat},${lon})[tourism=attraction][name];
    node(around:5000,${lat},${lon})[historic][name];
  );out center 12;`;
  const d = await upstreamJson<OverpassResp>(
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`,
    { timeoutMs: 10_000, minGapMs: 1500 },
  );
  const seen = new Set<string>();
  const out: { name: string; kind: string }[] = [];
  for (const el of d.elements ?? []) {
    const name = el.tags?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const kind = el.tags?.aeroway
      ? "airport"
      : el.tags?.amenity === "hospital"
        ? "hospital"
        : el.tags?.historic
          ? "historic"
          : "attraction";
    out.push({ name, kind });
    if (out.length >= 10) break;
  }
  return out;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const lat = Number(sp.get("lat"));
  const lon = Number(sp.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "lat/lon required" }, { status: 400 });
  }
  const zoom = Number(sp.get("zoom")) || 12;
  const scope = sp.get("scope") ?? ""; // continent | country | ocean | ""
  const title = sp.get("title") ?? ""; // named article for instant-band scopes
  const full = sp.get("full") === "1";
  const wideScope = scope === "continent" || scope === "ocean";

  // address is meaningless for a continent/ocean click
  const revP = wideScope
    ? Promise.resolve<Nominatim>({})
    : upstreamJson<Nominatim>(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=${rzoomFor(zoom)}`,
        { minGapMs: 1000, timeoutMs: 8000 },
      );
  // named scope → that exact article; otherwise nearest geotagged article
  const geoP = title
    ? Promise.resolve<GeoSearch>({ query: { geosearch: [{ title, pageid: 0, dist: 0 }] } })
    : upstreamJson<GeoSearch>(
        `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}%7C${lon}&gsradius=10000&gslimit=1&format=json&origin=*`,
        { timeoutMs: 8000 },
      );
  const wxP = upstreamJson<OpenMeteo>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m`,
    { timeoutMs: 8000 },
  );
  const galleryP = full ? commonsGallery(lat, lon) : Promise.resolve([]);
  const poisP = full && !wideScope ? nearbyPois(lat, lon) : Promise.resolve([]);

  const [rev, geo, wx, gal, pois] = await Promise.allSettled([revP, geoP, wxP, galleryP, poisP]);

  const address = rev.status === "fulfilled" ? rev.value.display_name ?? "" : "";

  let wiki: { title?: string; extract?: string; thumb?: string; url?: string } = {};
  let facts: Record<string, string> = {};
  if (geo.status === "fulfilled") {
    const hit = geo.value.query?.geosearch?.[0];
    if (hit) {
      try {
        const sum = await upstreamJson<WikiSummary>(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`,
          { timeoutMs: 8000 },
        );
        wiki = {
          title: sum.title,
          extract: sum.extract,
          thumb: sum.thumbnail?.source,
          url: sum.content_urls?.desktop?.page,
        };
        if (full && sum.wikibase_item) {
          try {
            facts = await wikidataFacts(sum.wikibase_item);
          } catch {
            /* facts stay empty */
          }
        }
      } catch {
        /* summary failed — keep the rest of the card */
      }
    }
  }

  let weather: { temp?: number; desc?: string; wind?: number } = {};
  if (wx.status === "fulfilled" && wx.value.current) {
    const c = wx.value.current;
    weather = { temp: c.temperature_2m, desc: WMO[c.weather_code ?? -1], wind: c.wind_speed_10m };
  }

  return Response.json(
    {
      lat,
      lon,
      scope,
      address,
      wiki,
      weather,
      facts,
      gallery: gal.status === "fulfilled" ? gal.value : [],
      pois: pois.status === "fulfilled" ? pois.value : [],
    },
    { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=7200" } },
  );
}
