import type { NextRequest } from "next/server";
import { upstreamJson } from "@/src/core/upstream";

// Windy Webcams v3 proxy — the global (keyed) half of the webcams layer; the
// curated YouTube Lives half is keyless and client-side. Key stays server-only.
// v3 has no bbox filter on /webcams, so we translate the AOI to nearby=lat,lon,r
// (km, clamped to Windy's 250 km cap). Image tokens expire after 10 min on the
// free tier — keep the edge cache well under that.

const KEY = process.env.WINDY_API_KEY;
const BASE = "https://api.windy.com/webcams/api/v3/webcams";
const PAGE = 50; // Windy's max limit per request

interface WindyWebcam {
  webcamId?: number;
  title?: string;
  status?: string;
  location?: { latitude?: number; longitude?: number; city?: string; country?: string };
  images?: { current?: { preview?: string; thumbnail?: string } };
  player?: { live?: string; day?: string };
}

export async function GET(req: NextRequest) {
  if (!KEY) return Response.json({ cameras: [], keyless: true });

  const bbox = (req.nextUrl.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    return Response.json({ error: "bbox=w,s,e,n required" }, { status: 400 });
  }
  const [w, s, e, n] = bbox;
  const lat = (s + n) / 2;
  const lon = (w + e) / 2;
  // half-diagonal in km ≈ radius that covers the AOI corners
  const dLatKm = ((n - s) / 2) * 111;
  const dLonKm = ((e - w) / 2) * 111 * Math.cos((lat * Math.PI) / 180);
  const radius = Math.min(250, Math.max(10, Math.round(Math.hypot(dLatKm, dLonKm))));

  try {
    const page = (offset: number) =>
      upstreamJson<{ webcams?: WindyWebcam[]; total?: number }>(
        `${BASE}?nearby=${lat.toFixed(4)},${lon.toFixed(4)},${radius}&include=location,images,player&limit=${PAGE}&offset=${offset}`,
        { headers: { "x-windy-api-key": KEY } },
      );
    const first = await page(0);
    const rest = (first.total ?? 0) > PAGE ? await page(PAGE).catch(() => ({ webcams: [] })) : { webcams: [] };
    const cameras = [...(first.webcams ?? []), ...(rest.webcams ?? [])].flatMap((c) => {
      const la = c.location?.latitude;
      const lo = c.location?.longitude;
      if (la == null || lo == null || c.status === "inactive") return [];
      const place = [c.location?.city, c.location?.country].filter(Boolean).join(", ");
      return [{
        id: `windy-${c.webcamId}`,
        lng: lo,
        lat: la,
        label: c.title || place || "Webcam",
        provider: "Windy",
        imageUrl: c.images?.current?.preview ?? c.images?.current?.thumbnail ?? "",
        embedUrl: c.player?.live ?? c.player?.day,
      }];
    });
    return Response.json(
      { cameras },
      { headers: { "Cache-Control": "s-maxage=240, stale-while-revalidate=60" } },
    );
  } catch {
    return Response.json({ error: "windy upstream failed" }, { status: 502 });
  }
}
