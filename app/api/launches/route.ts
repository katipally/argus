import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamJson } from "@/src/core/upstream";

// Upcoming rocket launches — Launch Library 2 (TheSpaceDevs, open API). The
// anonymous tier allows ~15 req/hr, so the parsed result is memoized in-module
// for 45 min — plenty for a schedule that shifts by hours, and it keeps Argus
// polite no matter how many clients hit this route.
const URL = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=40&hide_recent_previous=true";

interface Ll2Launch {
  name?: string;
  net?: string;
  status?: { abbrev?: string };
  pad?: { latitude?: string; longitude?: string; location?: { name?: string } };
  launch_service_provider?: { name?: string };
  mission?: { description?: string; type?: string };
  url?: string;
}

let memo: { t: number; fc: FeatureCollection<Point> } | null = null;
const TTL = 45 * 60_000;

function severity(netMs: number): number {
  const dt = netMs - Date.now();
  if (dt < 24 * 3600_000) return 3; // launching within a day
  if (dt < 7 * 24 * 3600_000) return 2;
  return 1;
}

export async function GET() {
  try {
    if (!memo || Date.now() - memo.t > TTL) {
      const d = await upstreamJson<{ results?: Ll2Launch[] }>(URL, { timeoutMs: 15_000, minGapMs: 2000 });
      const features: Feature<Point>[] = [];
      for (const l of d.results ?? []) {
        const lat = Number(l.pad?.latitude);
        const lon = Number(l.pad?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const netMs = l.net ? Date.parse(l.net) || 0 : 0;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            name: l.name ?? "Launch",
            net: l.net ?? "",
            ts: netMs,
            status: l.status?.abbrev ?? "",
            pad: l.pad?.location?.name ?? "",
            provider: l.launch_service_provider?.name ?? "",
            missionType: l.mission?.type ?? "",
            severity: severity(netMs),
          },
        });
      }
      memo = { t: Date.now(), fc: { type: "FeatureCollection", features } };
    }
    return Response.json(memo.fc, {
      headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=3600" },
    });
  } catch {
    return Response.json({ error: "launches failed" }, { status: 502 });
  }
}
