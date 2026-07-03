import type { NextRequest } from "next/server";
import { CAMERA_PROVIDERS, type CameraProvider } from "@/src/layers/feeds/camera-providers";
import { upstreamFetch } from "@/src/core/upstream";

// Normalizes keyless traffic-camera providers to a common CameraFeature shape.
// Keyed providers (Windy) are fetched client-side and never hit this route.
// Parser families: caltrans (per-district JSON), cr-list (Castle Rock classic
// 511, paginated 100/page), cr-graphql (Castle Rock SPA, bbox-native), plus
// five one-off state feeds. Every provider curl-verified keyless 2026-07.

interface CameraFeature {
  id: string;
  lng: number;
  lat: number;
  label: string;
  provider: string;
  imageUrl: string;
  streamUrl?: string;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Caltrans ──────────────────────────────────────────────────────────────
interface CaltransRow {
  cctv?: {
    index?: string;
    inService?: string;
    location?: { latitude?: string; longitude?: string; locationName?: string; nearbyPlace?: string };
    imageData?: { streamingVideoURL?: string; static?: { currentImageURL?: string } };
  };
}

async function fetchCaltrans(district: string): Promise<CameraFeature[]> {
  const n = district.replace(/\D/g, "");
  if (!n) return [];
  const url = `https://cwwp2.dot.ca.gov/data/d${n}/cctv/cctvStatusD${n.padStart(2, "0")}.json`;
  const r = await upstreamFetch(url);
  if (!r.ok) throw new Error(`caltrans ${r.status}`);
  const d = (await r.json()) as { data?: CaltransRow[] };
  const out: CameraFeature[] = [];
  for (const row of d.data ?? []) {
    const c = row.cctv;
    const loc = c?.location;
    const img = c?.imageData?.static?.currentImageURL;
    if (!c || c.inService !== "true" || !img) continue;
    const lat = num(loc?.latitude);
    const lng = num(loc?.longitude);
    if (lat == null || lng == null) continue;
    out.push({
      id: `caltrans-${district}-${c.index ?? out.length}`,
      lng,
      lat,
      label: loc?.locationName || loc?.nearbyPlace || "CCTV",
      provider: "Caltrans",
      imageUrl: img,
      streamUrl: c.imageData?.streamingVideoURL,
    });
  }
  return out;
}

// ── Castle Rock classic list API ─────────────────────────────────────────
// Server caps pages at 100 rows; fetch up to 10 pages and cache the full list
// in module memory. ponytail: big states (GA/FL ~5k cams) surface their first
// 1000 — full pagination if coverage gaps actually bite.
interface CrListRow {
  id?: number | string;
  location?: string;
  roadway?: string;
  latLng?: { geography?: { wellKnownText?: string } };
  images?: { imageUrl?: string; videoUrl?: string; isVideoAuthRequired?: boolean }[];
}

const crCache = new Map<string, { at: number; cams: CameraFeature[] }>();
const CR_TTL = 10 * 60_000;
const PAGE = 100;

async function crPage(base: string, start: number): Promise<{ rows: CrListRow[]; total: number }> {
  const query = encodeURIComponent(JSON.stringify({ columns: [{ data: null, name: "" }], start, length: PAGE }));
  const r = await upstreamFetch(`${base}/List/GetData/Cameras?query=${query}`, { minGapMs: 150 });
  if (!r.ok) throw new Error(`cr ${r.status}`);
  const d = (await r.json()) as { data?: CrListRow[]; recordsTotal?: number };
  return { rows: d.data ?? [], total: d.recordsTotal ?? 0 };
}

async function fetchCrList(p: CameraProvider): Promise<CameraFeature[]> {
  const cached = crCache.get(p.id);
  if (cached && Date.now() - cached.at < CR_TTL) return cached.cams;
  const base = p.base!;
  const first = await crPage(base, 0);
  const pages = Math.min(Math.ceil(first.total / PAGE), 10);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => crPage(base, (i + 1) * PAGE).catch(() => ({ rows: [] as CrListRow[], total: 0 }))),
  );
  const cams: CameraFeature[] = [];
  for (const row of [first, ...rest].flatMap((x) => x.rows)) {
    const wkt = row.latLng?.geography?.wellKnownText ?? "";
    const m = wkt.match(/POINT \((-?[\d.]+) (-?[\d.]+)\)/);
    if (!m) continue;
    const img = row.images?.[0];
    if (!img?.imageUrl) continue;
    cams.push({
      id: `${p.id}-${row.id ?? cams.length}`,
      lng: Number(m[1]),
      lat: Number(m[2]),
      label: row.location || row.roadway || "CCTV",
      provider: p.label,
      imageUrl: img.imageUrl.startsWith("http") ? img.imageUrl : `${base}${img.imageUrl}`,
      streamUrl: img.videoUrl && !img.isVideoAuthRequired ? img.videoUrl : undefined,
    });
  }
  crCache.set(p.id, { at: Date.now(), cams });
  return cams;
}

// ── Castle Rock SPA GraphQL (bbox-native) ────────────────────────────────
interface CrgFeature {
  __typename?: string;
  title?: string;
  uri?: string;
  features?: { geometry?: { coordinates?: number[] } }[];
  views?: { url?: string }[];
}

async function fetchCrGraphql(p: CameraProvider, bbox: number[]): Promise<CameraFeature[]> {
  const [w, s, e, n] = bbox;
  const body = {
    operationName: "MapFeatures",
    query:
      "query MapFeatures($input: MapFeaturesArgs!) { mapFeaturesQuery(input: $input) { mapFeatures { title uri __typename features { id geometry properties type } ... on Camera { views(limit: 5) { uri ... on CameraView { url } category } } } error { message type } } }",
    variables: {
      input: { north: n, south: s, east: e, west: w, zoom: 11, layerSlugs: ["normalCameras"] },
    },
  };
  // upstreamFetch is GET-shaped; this API needs a POST, so fetch directly with
  // the same timeout discipline.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${p.base}/api/graphql`, {
      method: "POST",
      cache: "no-store",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`crg ${res.status}`);
    const d = (await res.json()) as { data?: { mapFeaturesQuery?: { mapFeatures?: CrgFeature[] } } };
    const cams: CameraFeature[] = [];
    for (const f of d.data?.mapFeaturesQuery?.mapFeatures ?? []) {
      if (f.__typename !== "Camera") continue;
      const coords = f.features?.[0]?.geometry?.coordinates;
      const url = f.views?.[0]?.url;
      if (!coords || coords.length < 2 || !url) continue;
      cams.push({
        id: `${p.id}-${f.uri ?? cams.length}`,
        lng: coords[0],
        lat: coords[1],
        label: f.title || "CCTV",
        provider: p.label,
        imageUrl: url,
      });
    }
    return cams;
  } finally {
    clearTimeout(timer);
  }
}

// ── One-off state feeds ───────────────────────────────────────────────────
async function fetchDeldot(): Promise<CameraFeature[]> {
  const r = await upstreamFetch("https://tmc.deldot.gov/json/videocamera.json");
  if (!r.ok) throw new Error(`deldot ${r.status}`);
  const d = (await r.json()) as { videoCameras?: { id?: string; title?: string; lat?: number; lon?: number; urls?: { m3u8s?: string } }[] };
  return (d.videoCameras ?? []).flatMap((c) => {
    const lat = num(c.lat);
    const lng = num(c.lon);
    if (lat == null || lng == null) return [];
    return [{ id: `deldot-${c.id}`, lng, lat, label: c.title || "CCTV", provider: "DelDOT", imageUrl: "", streamUrl: c.urls?.m3u8s }];
  });
}

async function fetchMdChart(): Promise<CameraFeature[]> {
  const r = await upstreamFetch("https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do");
  if (!r.ok) throw new Error(`md ${r.status}`);
  const d = (await r.json()) as { data?: { id?: string; name?: string; lat?: number; lon?: number; cctvIp?: string }[] };
  return (d.data ?? []).flatMap((c) => {
    const lat = num(c.lat);
    const lng = num(c.lon);
    if (lat == null || lng == null) return [];
    return [{
      id: `md-${c.id}`,
      lng,
      lat,
      label: c.name || "CCTV",
      provider: "MD CHART",
      imageUrl: "",
      streamUrl: c.cctvIp && c.id ? `https://${c.cctvIp}/rtplive/${c.id}/playlist.m3u8` : undefined,
    }];
  });
}

async function fetchOregon(): Promise<CameraFeature[]> {
  // tripcheck 406s on Accept: application/json — ask for anything
  const r = await upstreamFetch("https://www.tripcheck.com/Scripts/map/data/cctvinventory.js", {
    headers: { Accept: "*/*" },
  });
  if (!r.ok) throw new Error(`or ${r.status}`);
  const d = (await r.json()) as { features?: { attributes?: { latitude?: number; longitude?: number; title?: string; filename?: string; cctvid?: string } }[] };
  return (d.features ?? []).flatMap(({ attributes: a }) => {
    const lat = num(a?.latitude);
    const lng = num(a?.longitude);
    if (lat == null || lng == null || !a?.filename) return [];
    return [{
      id: `or-${a.cctvid ?? a.filename}`,
      lng,
      lat,
      label: a.title || "CCTV",
      provider: "TripCheck",
      imageUrl: `https://tripcheck.com/RoadCams/cams/${a.filename}`,
    }];
  });
}

async function fetchModot(): Promise<CameraFeature[]> {
  const r = await upstreamFetch("https://traveler.modot.org/timconfig/feed/desktop/StreamingCams2.json");
  if (!r.ok) throw new Error(`mo ${r.status}`);
  const d = (await r.json()) as { location?: string; x?: number; y?: number; html?: string; id?: string }[];
  return (Array.isArray(d) ? d : []).flatMap((c) => {
    const lat = num(c.y);
    const lng = num(c.x);
    if (lat == null || lng == null) return [];
    const stream = (c.html ?? "").match(/https?:\/\/\S+?playlist\.m3u8/)?.[0] ?? (c.html?.endsWith(".m3u8") ? c.html : undefined);
    return [{ id: `mo-${c.id ?? c.location}`, lng, lat, label: c.location || "CCTV", provider: "MoDOT", imageUrl: "", streamUrl: stream }];
  });
}

let tdotKey: string | null = null;
async function fetchTdot(): Promise<CameraFeature[]> {
  if (!tdotKey) {
    const cfg = await upstreamFetch("https://smartway.tn.gov/config/config.json");
    if (cfg.ok) tdotKey = ((await cfg.json()) as { apiKey?: string; ApiKey?: string }).apiKey ?? null;
  }
  if (!tdotKey) return [];
  const r = await upstreamFetch("https://www.tdot.tn.gov/opendata/api/public/RoadwayCameras", {
    headers: { ApiKey: tdotKey },
  });
  if (!r.ok) throw new Error(`tn ${r.status}`);
  const d = (await r.json()) as { lat?: number; lng?: number; title?: string; thumbnailUrl?: string; httpsVideoUrl?: string; id?: string }[];
  return (Array.isArray(d) ? d : []).flatMap((c) => {
    const lat = num(c.lat);
    const lng = num(c.lng);
    if (lat == null || lng == null) return [];
    return [{ id: `tn-${c.id ?? c.title}`, lng, lat, label: c.title || "CCTV", provider: "TDOT SmartWay", imageUrl: c.thumbnailUrl ?? "", streamUrl: c.httpsVideoUrl }];
  });
}

// ── dispatch ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const id = q.get("provider") ?? "";
  const provider = CAMERA_PROVIDERS.find((p) => p.id === id);
  if (!provider) return Response.json({ error: `unknown provider ${id}` }, { status: 400 });
  try {
    let cams: CameraFeature[];
    switch (provider.kind) {
      case "caltrans":
        cams = await fetchCaltrans(id.slice("caltrans-".length));
        break;
      case "cr-list":
        cams = await fetchCrList(provider);
        break;
      case "cr-graphql": {
        const bbox = (q.get("bbox") ?? "").split(",").map(Number);
        if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
          return Response.json({ error: "bbox required for this provider" }, { status: 400 });
        }
        cams = await fetchCrGraphql(provider, bbox);
        break;
      }
      case "deldot":
        cams = await fetchDeldot();
        break;
      case "md-chart":
        cams = await fetchMdChart();
        break;
      case "oregon":
        cams = await fetchOregon();
        break;
      case "modot":
        cams = await fetchModot();
        break;
      case "tdot":
        cams = await fetchTdot();
        break;
    }
    return Response.json(
      { cameras: cams },
      { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } },
    );
  } catch {
    return Response.json({ error: `provider ${id} failed` }, { status: 502 });
  }
}
