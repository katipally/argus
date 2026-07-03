import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";

// GDACS = UN/EU disaster alerts (floods, cyclones, quakes, droughts, volcanoes).
// Keyless; proxied for CORS + edge caching + normalization.
interface GdacsFeature {
  geometry?: { type: string; coordinates: [number, number] };
  properties?: Record<string, unknown>;
}

export async function GET() {
  try {
    const r = await upstreamFetch(
      "https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP",
      { timeoutMs: 10_000 },
    );
    if (!r.ok) return Response.json({ error: `gdacs ${r.status}` }, { status: 502 });
    const d = (await r.json()) as { features?: GdacsFeature[] };

    const features: Feature<Point>[] = (d.features ?? [])
      .filter((f) => f.geometry?.type === "Point")
      .map((f) => {
        const p = f.properties ?? {};
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: f.geometry!.coordinates },
          properties: {
            eventtype: String(p.eventtype ?? ""),
            name: String(p.name ?? p.eventname ?? "Disaster event"),
            alert: String(p.alertlevel ?? ""),
            from: String(p.fromdate ?? ""),
            description: String(p.description ?? ""),
            url: String((p.url as { report?: string })?.report ?? ""),
          },
        };
      });

    const fc: FeatureCollection<Point> = { type: "FeatureCollection", features };
    return Response.json(fc, {
      headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" },
    });
  } catch {
    return Response.json({ error: "gdacs failed" }, { status: 502 });
  }
}
