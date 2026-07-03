import type { NextRequest } from "next/server";
import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";

// Earthquakes, MULTI-SOURCE. USGS is authoritative globally (esp. the Americas);
// EMSC/seismicportal has far denser Euro-Mediterranean & Middle-East coverage
// and often reports faster there. We fetch both, normalize EMSC into USGS's
// property shape, and merge/dedupe by space+time so the same quake reported by
// both catalogs appears once (USGS kept as authoritative). Both keyless.
// The response stays USGS-shaped so the client layer needs no changes; the
// contributing catalogs are reported in X-Argus-Sources.

interface EmscProps {
  mag?: number;
  flynn_region?: string;
  time?: string;
  depth?: number;
  unid?: string;
}

/** Same quake in both catalogs → one ~0.1°, 3-minute bucket. */
function dedupeKey(lng: number, lat: number, timeMs: number): string {
  return `${lat.toFixed(1)}:${lng.toFixed(1)}:${Math.round(timeMs / 180_000)}`;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const num = (k: string, lo: number, hi: number) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
  };
  const west = num("west", -180, 180);
  const south = num("south", -90, 90);
  const east = num("east", -180, 180);
  const north = num("north", -90, 90);
  if (west == null || south == null || east == null || north == null) {
    return Response.json({ error: "bbox required" }, { status: 400 });
  }
  const days = num("days", 1, 30) ?? 7;
  const start = new Date(Date.now() - days * 86_400_000).toISOString();

  const usgsUrl =
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&starttime=${start}&minlatitude=${south}&maxlatitude=${north}` +
    `&minlongitude=${west}&maxlongitude=${east}&limit=2000&orderby=time`;
  const emscUrl =
    `https://www.seismicportal.eu/fdsnws/event/1/query?format=json` +
    `&start=${start}&minlat=${south}&maxlat=${north}` +
    `&minlon=${west}&maxlon=${east}&limit=1000&orderby=time`;

  // Soft deadline: return with whatever arrived in ~4s (quakes are cached 5min,
  // so a slow catalog just sits out this refresh — never blocks the layer).
  const SLOW = Symbol("slow");
  const soft = new Promise<typeof SLOW>((r) => setTimeout(() => r(SLOW), 4_000));
  const grab = async (url: string) => {
    const r = await upstreamFetch(url, { timeoutMs: 9_000 });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as FeatureCollection;
  };
  const [usgs, emsc] = await Promise.all([
    Promise.race([grab(usgsUrl), soft]).catch(() => SLOW),
    Promise.race([grab(emscUrl), soft]).catch(() => SLOW),
  ]);

  const sources: string[] = [];
  const seen = new Set<string>();
  const features: Feature<Point>[] = [];

  // USGS first (authoritative) — kept as-is, just tag the source.
  if (usgs !== SLOW && typeof usgs !== "symbol") {
    sources.push("USGS");
    for (const f of (usgs as FeatureCollection).features) {
      if (f.geometry?.type !== "Point") continue;
      const [lng, lat] = f.geometry.coordinates as number[];
      const t = Number((f.properties ?? {}).time) || 0;
      seen.add(dedupeKey(lng, lat, t));
      features.push({
        ...(f as Feature<Point>),
        properties: { ...(f.properties ?? {}), source: "USGS" },
      });
    }
  }

  // EMSC normalized into USGS-shaped properties; skip ones USGS already has.
  if (emsc !== SLOW && typeof emsc !== "symbol") {
    sources.push("EMSC");
    for (const f of (emsc as FeatureCollection).features) {
      if (f.geometry?.type !== "Point") continue;
      const p = (f.properties ?? {}) as EmscProps;
      const [lng, lat] = f.geometry.coordinates as number[];
      const timeMs = p.time ? Date.parse(p.time) : 0;
      if (seen.has(dedupeKey(lng, lat, timeMs))) continue;
      features.push({
        type: "Feature",
        geometry: f.geometry as Point,
        id: p.unid,
        properties: {
          mag: typeof p.mag === "number" ? p.mag : null,
          place: p.flynn_region ?? "Seismic event",
          time: timeMs,
          code: p.unid,
          source: "EMSC",
        },
      });
    }
  }

  if (sources.length === 0) {
    return Response.json({ error: "all seismic sources failed" }, { status: 502 });
  }

  const fc: FeatureCollection = { type: "FeatureCollection", features };
  return Response.json(fc, {
    headers: {
      "Cache-Control": "s-maxage=300, stale-while-revalidate=600",
      "X-Argus-Sources": sources.join(","),
    },
  });
}
