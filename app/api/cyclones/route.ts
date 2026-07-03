import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamJson } from "@/src/core/upstream";

// Active tropical cyclones — NOAA NHC CurrentStorms.json (public domain,
// Atlantic + East/Central Pacific). West Pacific / Indian Ocean storms surface
// through the GDACS Disasters layer; NHC gives the richer live detail where it
// has coverage. lat/lon come as "17.4N" / "127.1W" strings.
const URL = "https://www.nhc.noaa.gov/CurrentStorms.json";

interface NhcStorm {
  id?: string;
  name?: string;
  classification?: string; // TD/TS/HU/PTC…
  intensity?: string; // knots
  pressure?: string; // mb
  latitude?: string;
  longitude?: string;
  movementDir?: number;
  movementSpeed?: number;
  lastUpdate?: string;
}

function coord(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/^([\d.]+)([NSEW])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /[SW]/i.test(m[2]) ? -n : n;
}

const CLASS_NAME: Record<string, string> = {
  TD: "Tropical Depression",
  TS: "Tropical Storm",
  HU: "Hurricane",
  MH: "Major Hurricane",
  PTC: "Post-tropical Cyclone",
  STD: "Subtropical Depression",
  STS: "Subtropical Storm",
};

function severity(cls: string, kt: number): number {
  if (cls === "MH" || kt >= 96) return 4;
  if (cls === "HU" || kt >= 64) return 4;
  if (cls === "TS" || kt >= 34) return 3;
  return 2;
}

export async function GET() {
  try {
    const d = await upstreamJson<{ activeStorms?: NhcStorm[] }>(URL, { timeoutMs: 10_000 });
    const features: Feature<Point>[] = [];
    for (const s of d.activeStorms ?? []) {
      const lat = coord(s.latitude);
      const lon = coord(s.longitude);
      if (lat == null || lon == null) continue;
      const kt = Number(s.intensity) || 0;
      const cls = s.classification ?? "";
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          name: s.name ?? "Storm",
          class: CLASS_NAME[cls] ?? cls,
          windKt: kt,
          pressure: Number(s.pressure) || null,
          moving: s.movementDir != null ? `${s.movementDir}° at ${s.movementSpeed ?? "?"} kt` : "",
          severity: severity(cls, kt),
          ts: s.lastUpdate ? Date.parse(s.lastUpdate) || null : null,
          url: "https://www.nhc.noaa.gov/",
        },
      });
    }
    const fc: FeatureCollection<Point> = { type: "FeatureCollection", features };
    return Response.json(fc, {
      headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=1800" },
    });
  } catch {
    return Response.json({ error: "nhc failed" }, { status: 502 });
  }
}
