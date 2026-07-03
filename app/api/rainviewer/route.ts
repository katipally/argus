import { upstreamJson } from "@/src/core/upstream";

// RainViewer public radar frame index (keyless, non-commercial). We return only
// the host + latest frame paths; the browser loads the actual PNG tiles directly
// from RainViewer's tilecache (no proxying megabytes of imagery through us).
interface RvIndex {
  host: string;
  radar?: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] };
}

export async function GET() {
  try {
    const d = await upstreamJson<RvIndex>("https://api.rainviewer.com/public/weather-maps.json", {
      timeoutMs: 8_000,
    });
    const frames = [...(d.radar?.past ?? []), ...(d.radar?.nowcast ?? [])];
    return Response.json(
      { host: d.host, frames },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch {
    return Response.json({ error: "rainviewer failed" }, { status: 502 });
  }
}
