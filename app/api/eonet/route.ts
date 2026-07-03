import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";

// NASA EONET = live natural events (wildfires, severe storms, volcanoes, ice).
// Keyless GeoJSON; proxied for CORS + caching + normalization to points.
interface EonetFeature {
  geometry?: {
    type: string;
    coordinates: number[] | number[][];
  };
  properties?: {
    title?: string;
    date?: string;
    magnitudeValue?: number;
    magnitudeUnit?: string;
    link?: string;
    categories?: { title?: string }[];
  };
}

export async function GET() {
  try {
    const r = await upstreamFetch(
      "https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&limit=500",
    );
    if (!r.ok) return Response.json({ error: `eonet ${r.status}` }, { status: 502 });
    const d = (await r.json()) as { features?: EonetFeature[] };

    const features: Feature<Point>[] = [];
    for (const f of d.features ?? []) {
      const g = f.geometry;
      if (!g) continue;
      let coord: number[] | undefined;
      if (g.type === "Point") coord = g.coordinates as number[];
      else if (g.type === "MultiPoint" || g.type === "LineString") {
        const arr = g.coordinates as number[][];
        coord = arr[arr.length - 1]; // latest known position of a track
      }
      if (!coord || coord.length < 2) continue;

      const p = f.properties ?? {};
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [coord[0], coord[1]] },
        properties: {
          title: p.title ?? "Event",
          category: p.categories?.[0]?.title ?? "Event",
          date: p.date ?? "",
          mag: p.magnitudeValue ? `${p.magnitudeValue} ${p.magnitudeUnit ?? ""}`.trim() : "",
          link: p.link ?? "",
        },
      });
    }

    const fc: FeatureCollection<Point> = { type: "FeatureCollection", features };
    return Response.json(fc, {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch {
    return Response.json({ error: "eonet failed" }, { status: 502 });
  }
}
