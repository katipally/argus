import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamJson } from "@/src/core/upstream";

// Space weather — NOAA SWPC (public domain): the OVATION aurora forecast grid
// (65k cells, we keep cells with probability ≥ 10%) + the live planetary Kp
// index. Both keyless, refreshed every few minutes upstream.
const AURORA = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";

interface Ovation {
  "Forecast Time"?: string;
  coordinates?: [number, number, number][]; // [lon 0-359, lat, aurora %]
}
interface KpRow {
  time_tag?: string;
  kp_index?: number;
  estimated_kp?: number;
}

export async function GET() {
  try {
    const [aur, kpRows] = await Promise.all([
      upstreamJson<Ovation>(AURORA, { timeoutMs: 15_000 }),
      upstreamJson<KpRow[]>(KP, { timeoutMs: 10_000 }).catch(() => [] as KpRow[]),
    ]);
    const features: Feature<Point>[] = [];
    for (const [lon0, lat, p] of aur.coordinates ?? []) {
      if (p < 10) continue;
      const lon = lon0 > 180 ? lon0 - 360 : lon0;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { p },
      });
    }
    const last = kpRows[kpRows.length - 1];
    const kp = last?.estimated_kp ?? last?.kp_index ?? null;
    const fc: FeatureCollection<Point> & { kp?: number | null; forecast?: string } = {
      type: "FeatureCollection",
      features,
    };
    return Response.json(
      { ...fc, kp, forecast: aur["Forecast Time"] ?? "" },
      { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" } },
    );
  } catch {
    return Response.json({ error: "swpc failed" }, { status: 502 });
  }
}
