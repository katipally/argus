import type { FeatureCollection } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";

// US National Weather Service active alerts (keyless GeoJSON, requires a UA).
// Many alerts carry a polygon; some only reference zones (no geometry) — we keep
// only the ones with geometry so they can be drawn directly.
export async function GET() {
  try {
    const r = await upstreamFetch("https://api.weather.gov/alerts/active?status=actual&message_type=alert", {
      timeoutMs: 10_000,
      headers: { Accept: "application/geo+json" },
    });
    if (!r.ok) return Response.json({ error: `nws ${r.status}` }, { status: 502 });
    const d = (await r.json()) as FeatureCollection;
    const features = (d.features ?? [])
      .filter((f) => f.geometry) // drop zone-only alerts with no drawable shape
      .map((f) => {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        return {
          type: "Feature" as const,
          geometry: f.geometry,
          properties: {
            event: String(p.event ?? "Alert"),
            severity: String(p.severity ?? "Unknown"),
            headline: String(p.headline ?? ""),
            area: String(p.areaDesc ?? ""),
            expires: String(p.expires ?? ""),
            url: String(p.id ?? ""),
          },
        };
      });
    return Response.json(
      { type: "FeatureCollection", features },
      { headers: { "Cache-Control": "s-maxage=120, stale-while-revalidate=240" } },
    );
  } catch {
    return Response.json({ error: "nws failed" }, { status: 502 });
  }
}
