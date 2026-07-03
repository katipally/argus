import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";
import { CENTROIDS } from "@/src/geo/country-centroids";

// WHO Disease Outbreak News — keyless, authoritative health-emergency feed.
// Items are article-shaped ("Disease - Country" / "Disease, CountryA & CountryB"),
// so we parse the title into disease + location(s) and geocode each country to
// its centroid. A handful worldwide at a time; refreshed as WHO declares events.
const WHO_URL =
  "https://www.who.int/api/news/diseaseoutbreaknews" +
  "?$orderby=PublicationDateAndTime%20desc&$top=40" +
  "&$select=Title,PublicationDate,UrlName,DonId";

// title location strings that don't map to a single country → skip a point.
const NON_GEO = /^(global|multi-?locations?|multi-?country|worldwide)$/i;

// aliases the centroid table doesn't key on directly.
const ALIAS: Record<string, string> = {
  "dr congo": "democratic republic of the congo",
  "drc": "democratic republic of the congo",
  "democratic republic of congo": "democratic republic of the congo",
  "the democratic republic of the congo": "democratic republic of the congo",
  usa: "united states of america",
  "united states": "united states of america",
  uk: "united kingdom",
  "u.k.": "united kingdom",
  "republic of korea": "south korea",
  "united republic of tanzania": "tanzania",
  "côte d'ivoire": "ivory coast",
  "cote d'ivoire": "ivory coast",
  "the gambia": "gambia",
};

function geocode(name: string): [number, number] | null {
  const key = name.trim().toLowerCase();
  const c = CENTROIDS[ALIAS[key] ?? key];
  return c ? [c[0], c[1]] : null;
}

/** "Nipah virus disease - India" → { disease, locations:["India"] } */
function parseTitle(title: string): { disease: string; locations: string[] } {
  let idx = title.lastIndexOf(" - ");
  let cut = 3;
  if (idx === -1) {
    idx = title.lastIndexOf(", ");
    cut = 2;
  }
  if (idx === -1) return { disease: title, locations: [] };
  const disease = title.slice(0, idx).trim();
  const locations = title
    .slice(idx + cut)
    .split(/\s*&\s*|\s+and\s+|\s*,\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return { disease, locations };
}

/** newer outbreaks read hotter (0–3). */
function severity(dateIso: string): number {
  const age = Date.now() - Date.parse(dateIso);
  if (!Number.isFinite(age)) return 1;
  const days = age / 86_400_000;
  if (days <= 30) return 3;
  if (days <= 90) return 2;
  return 1;
}

export async function GET() {
  try {
    const r = await upstreamFetch(WHO_URL, { timeoutMs: 10_000 });
    if (!r.ok) return Response.json({ error: `who ${r.status}` }, { status: 502 });
    const data = (await r.json()) as { value?: WhoItem[] };
    const items = Array.isArray(data.value) ? data.value : [];

    const features: Feature<Point>[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const title = String(it.Title ?? "").trim();
      if (!title) continue;
      const { disease, locations } = parseTitle(title);
      const date = String(it.PublicationDate ?? "");
      const url = it.UrlName ? `https://www.who.int/emergencies/disease-outbreak-news/item/${it.UrlName}` : "";
      for (const loc of locations) {
        if (NON_GEO.test(loc)) continue;
        const coord = geocode(loc);
        if (!coord) continue;
        // WHO posts sequential situation reports for the same ongoing outbreak,
        // so key on (disease, country) — items are date-desc, so the first we
        // see is the latest report and the rest of that event are skipped.
        const key = `${disease.toLowerCase()}:${loc.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coord },
          properties: {
            disease,
            country: loc,
            date: date.slice(0, 10),
            severity: severity(date),
            url,
          },
        });
      }
    }

    const fc: FeatureCollection = { type: "FeatureCollection", features };
    return Response.json(fc, {
      headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=7200" },
    });
  } catch {
    return Response.json({ error: "who fetch failed" }, { status: 502 });
  }
}

interface WhoItem {
  Title?: string;
  PublicationDate?: string;
  UrlName?: string;
  DonId?: string;
}
