import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamJson } from "@/src/core/upstream";

// Air quality — Open-Meteo Air Quality API (keyless, global, CAMS model).
// The API is point-based, so we sample a grid across the requested bbox in ONE
// multi-coordinate request and return graduated points. ponytail: model grid,
// not stations — good enough for a regional AQI picture.
const API = "https://air-quality-api.open-meteo.com/v1/air-quality";
const GRID = 7; // 7×7 = 49 sample points per AOI

interface OmAq {
  latitude: number;
  longitude: number;
  current?: { us_aqi?: number; pm2_5?: number; pm10?: number; ozone?: number };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const west = Number(q.get("west"));
  const south = Number(q.get("south"));
  const east = Number(q.get("east"));
  const north = Number(q.get("north"));
  if (![west, south, east, north].every(Number.isFinite)) {
    return Response.json({ error: "bbox required" }, { status: 400 });
  }

  const lats: number[] = [];
  const lons: number[] = [];
  // clamp: Open-Meteo rejects out-of-range coords; antimeridian wrap handled by unwrapping
  const eastU = east < west ? east + 360 : east;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const lat = south + ((north - south) * (i + 0.5)) / GRID;
      let lon = west + ((eastU - west) * (j + 0.5)) / GRID;
      if (lon > 180) lon -= 360;
      lats.push(Math.max(-89, Math.min(89, lat)));
      lons.push(lon);
    }
  }

  try {
    const data = await upstreamJson<OmAq | OmAq[]>(
      `${API}?latitude=${lats.map((v) => v.toFixed(3)).join(",")}&longitude=${lons.map((v) => v.toFixed(3)).join(",")}&current=us_aqi,pm2_5,pm10,ozone`,
      { timeoutMs: 12_000, minGapMs: 500 },
    );
    const rows = Array.isArray(data) ? data : [data];
    const features: Feature<Point>[] = [];
    for (const r of rows) {
      const aqi = r.current?.us_aqi;
      if (aqi == null) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.longitude, r.latitude] },
        properties: {
          aqi,
          pm25: r.current?.pm2_5 ?? null,
          pm10: r.current?.pm10 ?? null,
          ozone: r.current?.ozone ?? null,
        },
      });
    }
    const fc: FeatureCollection<Point> = { type: "FeatureCollection", features };
    return Response.json(fc, {
      headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=3600" },
    });
  } catch {
    return Response.json({ error: "airquality failed" }, { status: 502 });
  }
}
