import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";

// Smithsonian GVP / USGS Weekly Volcanic Activity Report (keyless RSS with
// georss:point per item). Items look like:
//   "Etna (Italy) - Report for 4 June-10 June 2026 - New Eruptive Activity"
// Updated every Thursday — only volcanoes with CURRENT activity appear.
const RSS = "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml";

function severity(status: string): number {
  const s = status.toLowerCase();
  if (s.includes("new eruptive")) return 4;
  if (s.includes("continuing eruptive")) return 3;
  if (s.includes("new unrest")) return 2;
  return 1;
}

export async function GET() {
  try {
    // the SI server 403s an Accept: application/json request — ask for XML
    const r = await upstreamFetch(RSS, { timeoutMs: 12_000, headers: { Accept: "application/rss+xml, text/xml, */*" } });
    if (!r.ok) return Response.json({ error: `gvp ${r.status}` }, { status: 502 });
    const xml = await r.text();

    const features: Feature<Point>[] = [];
    for (const item of xml.split("<item>").slice(1)) {
      const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
      const point = item.match(/<georss:point>([-\d. ]+)<\/georss:point>/)?.[1] ?? "";
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      const [lat, lon] = point.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // "Name (Country) - Report for <dates> - <Status>" — the dates contain a
      // hyphen ("4 June-10 June"), so the period group is GREEDY and the status
      // is whatever follows the LAST " - ".
      const m = title.match(/^(.*?)\s*\((.*?)\)\s*-\s*Report for\s*(.*)\s+-\s+(.*)$/);
      const name = m?.[1] ?? title;
      const country = m?.[2] ?? "";
      const period = m?.[3] ?? "";
      const status = m?.[4] ?? "Activity";
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { name, country, period, status, severity: severity(status), url: link },
      });
    }

    const fc: FeatureCollection<Point> = { type: "FeatureCollection", features };
    // weekly bulletin — cache aggressively
    return Response.json(fc, {
      headers: { "Cache-Control": "s-maxage=21600, stale-while-revalidate=86400" },
    });
  } catch {
    return Response.json({ error: "gvp failed" }, { status: 502 });
  }
}
