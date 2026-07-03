import { upstreamFetch } from "@/src/core/upstream";

// CelesTrak orbital elements (TLE). Keyless but asks not to be hammered — data
// only changes every few hours, so we cache 6h and the client propagates each
// satellite's position locally with satellite.js (zero ongoing network load).
// Only an allowlisted set of small groups is fetchable (not the full catalog).
const GROUPS = new Set(["stations", "visual", "science", "weather", "gps-ops"]);

export async function GET(req: Request) {
  const group = new URL(req.url).searchParams.get("group") ?? "stations";
  if (!GROUPS.has(group)) return new Response("bad group", { status: 400 });
  try {
    const r = await upstreamFetch(
      `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=TLE`,
      { timeoutMs: 10_000, headers: { Accept: "text/plain" } },
    );
    if (!r.ok) return new Response(`celestrak ${r.status}`, { status: 502 });
    const text = await r.text();
    return new Response(text, {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "s-maxage=21600, stale-while-revalidate=43200",
      },
    });
  } catch {
    return new Response("celestrak failed", { status: 502 });
  }
}
