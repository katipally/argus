import { upstreamFetch } from "@/src/core/upstream";
import { METEOALARM_COUNTRIES } from "@/src/layers/feeds/meteoalarm-countries";

// MeteoAlarm (EUMETNET) — official European weather warnings, keyless CAP/Atom
// feeds per country. Feeds carry EMMA region codes but NO geometry, so we return
// a per-country aggregate (counts by severity + top events) and the client drops
// one marker on the country centroid.
// ponytail: country-level dots; per-region polygons need the EMMA geocode
// dataset bundled (~MBs) — upgrade path if regional detail ever matters.

const FEED = (slug: string) => `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${slug}`;

const MAX_COUNTRIES = 6; // cap upstream fan-out per request (feeds are ~1 MB each)
const memo = new Map<string, { t: number; v: CountryAgg }>();
const TTL = 10 * 60_000;

interface CountryAgg {
  iso2: string;
  total: number;
  bySeverity: Record<string, number>;
  events: string[];
  maxSeverity: string;
}

const SEV_ORDER = ["Extreme", "Severe", "Moderate", "Minor"];

async function countryAgg(iso2: string, slug: string): Promise<CountryAgg | null> {
  const hit = memo.get(iso2);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  try {
    // meteoalarm 406s an Accept: application/json request — ask for Atom XML
    const r = await upstreamFetch(FEED(slug), {
      timeoutMs: 15_000,
      minGapMs: 300,
      headers: { Accept: "application/atom+xml, text/xml, */*" },
    });
    if (!r.ok) return null;
    const xml = await r.text();
    const now = Date.now();
    const bySeverity: Record<string, number> = {};
    const eventCounts = new Map<string, number>();
    let total = 0;
    for (const entry of xml.split("<entry>").slice(1)) {
      const sev = entry.match(/<cap:severity>(.*?)<\/cap:severity>/)?.[1] ?? "Unknown";
      const event = entry.match(/<cap:event>(.*?)<\/cap:event>/)?.[1] ?? "";
      const expires = entry.match(/<cap:expires>(.*?)<\/cap:expires>/)?.[1];
      const status = entry.match(/<cap:status>(.*?)<\/cap:status>/)?.[1] ?? "Actual";
      if (status !== "Actual") continue;
      if (expires && Date.parse(expires) < now) continue;
      total++;
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      if (event) eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);
    }
    const events = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${e} ×${n}`);
    const maxSeverity = SEV_ORDER.find((s) => bySeverity[s]) ?? "Minor";
    const v: CountryAgg = { iso2, total, bySeverity, events, maxSeverity };
    memo.set(iso2, { t: Date.now(), v });
    return v;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("countries") ?? "";
  const isos = raw.split(",").map((s) => s.trim().toUpperCase()).filter((s) => METEOALARM_COUNTRIES[s]).slice(0, MAX_COUNTRIES);
  if (!isos.length) return Response.json({ countries: [] });
  const results = await Promise.all(isos.map((iso) => countryAgg(iso, METEOALARM_COUNTRIES[iso])));
  return Response.json(
    { countries: results.filter(Boolean) },
    { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" } },
  );
}
