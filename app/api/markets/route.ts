import type { Feature, FeatureCollection, Point } from "geojson";
import { ARGUS_UA } from "@/src/core/upstream";

// Major stock-index quotes geolocated to their exchanges — Yahoo Finance's
// keyless v8 chart endpoint (meta block only: last price + previous close).
// One upstream call per index, in parallel; indices whose fetch fails are
// dropped from the FeatureCollection rather than failing the whole route.

const YA = "https://query1.finance.yahoo.com/v8/finance/chart/";

// symbol → exchange location
const INDICES: { sym: string; name: string; city: string; lng: number; lat: number }[] = [
  { sym: "^GSPC", name: "S&P 500", city: "New York", lng: -74.011, lat: 40.707 },
  { sym: "^IXIC", name: "Nasdaq Composite", city: "New York", lng: -73.986, lat: 40.757 },
  { sym: "^DJI", name: "Dow Jones", city: "New York", lng: -74.014, lat: 40.705 },
  { sym: "^GSPTSE", name: "S&P/TSX", city: "Toronto", lng: -79.38, lat: 43.648 },
  { sym: "^BVSP", name: "Bovespa", city: "São Paulo", lng: -46.634, lat: -23.546 },
  { sym: "^FTSE", name: "FTSE 100", city: "London", lng: -0.093, lat: 51.515 },
  { sym: "^GDAXI", name: "DAX", city: "Frankfurt", lng: 8.679, lat: 50.11 },
  { sym: "^FCHI", name: "CAC 40", city: "Paris", lng: 2.341, lat: 48.869 },
  { sym: "^N225", name: "Nikkei 225", city: "Tokyo", lng: 139.767, lat: 35.681 },
  { sym: "^HSI", name: "Hang Seng", city: "Hong Kong", lng: 114.158, lat: 22.284 },
  { sym: "000001.SS", name: "Shanghai Composite", city: "Shanghai", lng: 121.49, lat: 31.238 },
  { sym: "^BSESN", name: "Sensex", city: "Mumbai", lng: 72.834, lat: 18.93 },
  { sym: "^KS11", name: "KOSPI", city: "Seoul", lng: 126.978, lat: 37.566 },
  { sym: "^AXJO", name: "S&P/ASX 200", city: "Sydney", lng: 151.211, lat: -33.862 },
  { sym: "^STI", name: "Straits Times", city: "Singapore", lng: 103.851, lat: 1.284 },
];

interface ChartMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  regularMarketTime?: number;
  currency?: string;
  longName?: string;
}

async function quote(sym: string): Promise<ChartMeta | null> {
  try {
    const r = await fetch(`${YA}${encodeURIComponent(sym)}?range=1d&interval=1d`, {
      headers: { "User-Agent": ARGUS_UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { chart?: { result?: { meta?: ChartMeta }[] } };
    return d.chart?.result?.[0]?.meta ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const metas = await Promise.all(INDICES.map((i) => quote(i.sym)));
  const features: Feature<Point>[] = [];
  for (let i = 0; i < INDICES.length; i++) {
    const m = metas[i];
    const idx = INDICES[i];
    const price = m?.regularMarketPrice;
    const prev = m?.chartPreviousClose;
    if (price == null || prev == null || !prev) continue;
    const changePct = ((price - prev) / prev) * 100;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [idx.lng, idx.lat] },
      properties: {
        id: idx.sym,
        name: idx.name,
        city: idx.city,
        price,
        prev,
        changePct: Math.round(changePct * 100) / 100,
        currency: m?.currency ?? "",
        ts: (m?.regularMarketTime ?? 0) * 1000,
      },
    });
  }
  const fc: FeatureCollection<Point> = { type: "FeatureCollection", features };
  return Response.json(fc, {
    headers: { "Cache-Control": "s-maxage=120, stale-while-revalidate=300" },
  });
}
