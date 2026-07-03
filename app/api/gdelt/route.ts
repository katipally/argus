import type { Feature, FeatureCollection, Point } from "geojson";
import { unzipSync, strFromU8 } from "fflate";
import { upstreamFetch, ARGUS_UA } from "@/src/core/upstream";

// GDELT news/events geotagged to precise lat/lon. The GEO 2.0 API is dead (404)
// and the DOC API rate-limits hard (429), but the raw 15-minute Events files on
// data.gdeltproject.org are fast and un-throttled — and carry ActionGeo_Lat/Long
// per event plus the source article URL. We fetch the latest slice (~40 KB zip),
// unzip, parse the tab-delimited v2 schema, and normalize to GeoJSON points.
//
// v2 Events column indices (0-based): 0 id · 1 date · 31 goldstein · 33 mentions
// · 34 sources · 35 articles · 36 avgtone · 52 geo-name · 53 country · 56 lat
// · 57 lon · 60 source-url.
const LASTUPDATE = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";
const MAX = 3000;

export async function GET() {
  try {
    const idx = await upstreamFetch(LASTUPDATE, { timeoutMs: 8_000 });
    if (!idx.ok) return Response.json({ error: `gdelt idx ${idx.status}` }, { status: 502 });
    const manifest = await idx.text();
    // pick the export (Events) file — the smallest with per-event coordinates
    const url = manifest.split("\n").map((l) => l.trim().split(" ").pop() ?? "").find((u) => u.endsWith("export.CSV.zip"));
    if (!url) return Response.json({ error: "gdelt no export file" }, { status: 502 });

    const zres = await fetch(url, { headers: { "User-Agent": ARGUS_UA }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!zres.ok) return Response.json({ error: `gdelt zip ${zres.status}` }, { status: 502 });
    const buf = new Uint8Array(await zres.arrayBuffer());
    const files = unzipSync(buf);
    const csv = strFromU8(Object.values(files)[0] ?? new Uint8Array());

    const seen = new Set<string>();
    const features: Feature<Point>[] = [];
    for (const line of csv.split("\n")) {
      if (!line) continue;
      const c = line.split("\t");
      if (c.length < 61) continue;
      const lat = Number(c[56]);
      const lon = Number(c[57]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      const src = c[60];
      if (!src || seen.has(src)) continue; // one point per distinct article
      seen.add(src);
      let domain = "";
      try { domain = new URL(src).hostname.replace(/^www\./, ""); } catch { /* skip bad url */ }
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          id: c[0],
          place: c[52] || "Reported event",
          country: c[53] || "",
          tone: c[36] ? Number(c[36]) : null,
          articles: Number(c[35]) || 1,
          mentions: Number(c[33]) || 1,
          // QuadClass 4 = material conflict; GoldsteinScale is the cooperation↔conflict
          // intensity (−10..+10). Both let the Conflict layer filter this same feed.
          quad: Number(c[30]) || 0,
          goldstein: c[31] ? Number(c[31]) : null,
          // CAMEO root code — "14" = protest/demonstration (Unrest layer filter)
          root: c[28] || "",
          date: c[59] || c[1] || "",
          domain,
          url: src,
        },
      });
      if (features.length >= MAX) break;
    }

    const fc: FeatureCollection<Point> = { type: "FeatureCollection", features };
    return Response.json(fc, {
      headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=1800" },
    });
  } catch {
    return Response.json({ error: "gdelt failed" }, { status: 502 });
  }
}
