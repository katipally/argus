import type { Feature, FeatureCollection, Point } from "geojson";
import { upstreamFetch } from "@/src/core/upstream";

// NASA FIRMS active-fire detections (VIIRS) — KEYLESS. FIRMS publishes the
// global last-24h detections as an open CSV (no MAP_KEY): ~8 MB, so we memo the
// parsed rows in-module for 30 min and bbox-filter per request. When a free
// FIRMS_MAP_KEY IS set we use the bbox area API instead (smaller, fresher).
const KEY = process.env.FIRMS_MAP_KEY;
const GLOBAL_CSV =
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv";

interface FireRow {
  lat: number;
  lon: number;
  confidence: string;
  frp: string;
  ts: number;
}

let globalRows: { t: number; rows: FireRow[] } | null = null;
const GLOBAL_TTL = 30 * 60_000;

function parseCsv(csv: string): FireRow[] {
  const lines = csv.trim().split("\n");
  const header = lines[0]?.split(",") ?? [];
  const li = header.indexOf("latitude");
  const loi = header.indexOf("longitude");
  const ci = header.indexOf("confidence");
  const fi = header.indexOf("frp");
  const di = header.indexOf("acq_date");
  const ti = header.indexOf("acq_time");
  const rows: FireRow[] = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(",");
    const lat = Number(c[li]);
    const lon = Number(c[loi]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // acq_time is "HHMM" (UTC)
    const hhmm = (c[ti] ?? "0000").padStart(4, "0");
    const ts = Date.parse(`${c[di]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`) || 0;
    rows.push({ lat, lon, confidence: c[ci] ?? "", frp: c[fi] ?? "", ts });
  }
  return rows;
}

async function getGlobalRows(): Promise<FireRow[]> {
  if (globalRows && Date.now() - globalRows.t < GLOBAL_TTL) return globalRows.rows;
  const r = await upstreamFetch(GLOBAL_CSV, { timeoutMs: 25_000, headers: { Accept: "text/csv" } });
  if (!r.ok) throw new Error(`firms global ${r.status}`);
  const rows = parseCsv(await r.text());
  globalRows = { t: Date.now(), rows };
  return rows;
}

function toFc(rows: FireRow[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = rows.map((row) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [row.lon, row.lat] },
    properties: { confidence: row.confidence, frp: row.frp, ts: row.ts },
  }));
  return { type: "FeatureCollection", features };
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const bbox = sp.get("bbox"); // west,south,east,north
  if (!bbox || bbox.split(",").length !== 4) {
    return Response.json({ error: "bbox required" }, { status: 400 });
  }
  const [w, s, e, n] = bbox.split(",").map(Number);
  if ([w, s, e, n].some((v) => !Number.isFinite(v))) {
    return Response.json({ error: "bad bbox" }, { status: 400 });
  }

  try {
    // Keyed path: FIRMS area API (bbox-scoped, near-real-time)
    if (KEY) {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/VIIRS_SNPP_NRT/${w},${s},${e},${n}/1`;
      const r = await upstreamFetch(url, { timeoutMs: 12_000, headers: { Accept: "text/csv" } });
      if (r.ok) {
        return Response.json(toFc(parseCsv(await r.text())), {
          headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=3600" },
        });
      }
      // fall through to the keyless global file on any keyed failure
    }
    const rows = await getGlobalRows();
    const inLon = (lon: number) => (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);
    const within = rows.filter((row) => inLon(row.lon) && row.lat >= s && row.lat <= n).slice(0, 5000);
    return Response.json(toFc(within), {
      headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=1800" },
    });
  } catch {
    return Response.json({ error: "firms failed" }, { status: 502 });
  }
}
