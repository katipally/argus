import { upstreamFetch } from "@/src/core/upstream";

// Submarine cable geometries (TeleGeography's public map data, keyless).
// ~700 cables as MultiLineStrings with per-cable brand color + label point.
// Infrastructure changes on the order of months — cache a day at the edge.
const URL = "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json";

export async function GET() {
  try {
    const res = await upstreamFetch(URL, { timeoutMs: 15_000 });
    if (!res.ok) return Response.json({ error: `cables ${res.status}` }, { status: 502 });
    const body = await res.text();
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return Response.json({ error: "cables failed" }, { status: 502 });
  }
}
