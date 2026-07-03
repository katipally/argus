// Keyless place search via Photon (komoot) — built for typeahead, faster and
// more forgiving than Nominatim for partial queries. Falls back to Nominatim if
// Photon is unreachable. Returns a compact {name, lng, lat} list for the command bar.
import { upstreamJson } from "@/src/core/upstream";

interface PhotonFC {
  features?: {
    geometry?: { coordinates?: [number, number] };
    properties?: { name?: string; city?: string; state?: string; country?: string };
  }[];
}

function label(p: NonNullable<PhotonFC["features"]>[number]["properties"]): string {
  const parts = [p?.name, p?.city, p?.state, p?.country].filter(Boolean);
  return parts.join(", ");
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) return Response.json([], { status: 400 });

  try {
    const d = await upstreamJson<PhotonFC>(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`,
      { timeoutMs: 6000 },
    );
    const out = (d.features ?? [])
      .filter((f) => f.geometry?.coordinates)
      .map((f) => ({
        name: label(f.properties) || "Unnamed place",
        lng: f.geometry!.coordinates![0],
        lat: f.geometry!.coordinates![1],
      }));
    return Response.json(out, { headers: { "Cache-Control": "s-maxage=86400" } });
  } catch {
    // fallback: Nominatim (1 req/s)
    try {
      const d = await upstreamJson<{ display_name: string; lat: string; lon: string }[]>(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
        { minGapMs: 1000, timeoutMs: 8000 },
      );
      return Response.json(
        d.map((x) => ({ name: x.display_name, lng: Number(x.lon), lat: Number(x.lat) })),
        { headers: { "Cache-Control": "s-maxage=86400" } },
      );
    } catch {
      return Response.json([], { status: 502 });
    }
  }
}
