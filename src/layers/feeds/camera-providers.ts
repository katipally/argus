import type { Feature, FeatureCollection, Point } from "geojson";
import { type Bbox, bboxIntersects } from "@/src/core/bbox";

// A camera provider = one upstream feed with a coverage region. On each AOI change
// we query ONLY providers whose region intersects the AOI — that is what makes
// "worldwide catalog, load only the selected region/subregion" fall out for free.
// Adding coverage later is appending an entry here, not writing new layer code.
// Every entry curl-verified keyless with coords + image/stream (2026-07).
// Checked and EXCLUDED (key-gated / no API): TX, WA, OH, NJ, MI, VA, NC, OK.
export interface CameraProvider {
  id: string;
  label: string;
  region: Bbox;
  /** parser family the /api/cameras route uses. */
  kind: "caltrans" | "cr-list" | "cr-graphql" | "deldot" | "md-chart" | "oregon" | "modot" | "tdot";
  /** upstream base URL (castle-rock families and one-offs). */
  base?: string;
  /** keyed providers are fetched client-side with the user's key (never via our server). */
  keyed?: boolean;
}

/** Normalized camera the layer renders. */
export interface CameraFeature {
  id: string;
  lng: number;
  lat: number;
  label: string;
  provider: string;
  imageUrl: string;
  streamUrl?: string;
  /** Embeddable iframe (YouTube Live / Windy player) — beats stream/image when set. */
  embedUrl?: string;
}

// --- Caltrans CCTV: genuinely keyless, per-district JSON, thousands of cams. -------
// Districts carry rough coverage bboxes so an AOI over the Bay Area only pulls D04.
const CA = (west: number, south: number, east: number, north: number): Bbox => ({
  west,
  south,
  east,
  north,
});
export const CALTRANS_DISTRICTS: Record<string, Bbox> = {
  d1: CA(-124.5, 38.7, -122.3, 42.1), // North Coast (Eureka)
  d2: CA(-123.7, 39.3, -119.9, 42.1), // Northeast (Redding)
  d3: CA(-122.7, 37.9, -119.9, 40.2), // Sacramento
  d4: CA(-123.6, 36.9, -121.2, 38.9), // Bay Area
  d5: CA(-122.5, 34.4, -119.4, 37.6), // Central Coast (SLO/Santa Barbara)
  d6: CA(-120.9, 34.8, -117.6, 38.0), // Central Valley (Fresno)
  d7: CA(-119.2, 33.6, -117.6, 34.9), // LA / Ventura
  d8: CA(-117.8, 33.4, -114.1, 35.8), // San Bernardino / Riverside
  d9: CA(-119.5, 35.8, -117.5, 38.7), // Bishop (Eastern Sierra)
  d10: CA(-121.7, 37.1, -119.5, 38.6), // Stockton / Central
  d11: CA(-117.6, 32.5, -114.4, 33.5), // San Diego / Imperial
  d12: CA(-118.2, 33.3, -117.4, 33.95), // Orange County
};

// Keyless traffic-camera providers. Windy webcams are global + keyed, so they live
// on the server (/api/webcams, WINDY_API_KEY in .env) rather than in this catalog.
export const CAMERA_PROVIDERS: CameraProvider[] = [
  ...Object.entries(CALTRANS_DISTRICTS).map(
    ([d, region]): CameraProvider => ({ id: `caltrans-${d}`, label: `Caltrans ${d.toUpperCase()}`, region, kind: "caltrans" }),
  ),
  // Castle Rock "classic" 511 list API — one shared parser
  { id: "cr-id", label: "Idaho 511", kind: "cr-list", base: "https://511.idaho.gov", region: CA(-117.3, 41.9, -111.0, 49.0) },
  { id: "cr-pa", label: "511PA", kind: "cr-list", base: "https://www.511pa.com", region: CA(-80.6, 39.7, -74.6, 42.3) },
  { id: "cr-la", label: "511 Louisiana", kind: "cr-list", base: "https://511la.org", region: CA(-94.1, 28.9, -88.7, 33.1) },
  { id: "cr-nv", label: "NV Roads", kind: "cr-list", base: "https://www.nvroads.com", region: CA(-120.0, 35.0, -114.0, 42.0) },
  { id: "cr-az", label: "AZ 511", kind: "cr-list", base: "https://az511.gov", region: CA(-114.9, 31.3, -109.0, 37.0) },
  { id: "cr-wi", label: "511 Wisconsin", kind: "cr-list", base: "https://511wi.gov", region: CA(-92.9, 42.4, -86.7, 47.1) },
  { id: "cr-newengland", label: "New England 511", kind: "cr-list", base: "https://newengland511.org", region: CA(-73.5, 42.6, -66.8, 47.5) },
  { id: "cr-ga", label: "Georgia 511", kind: "cr-list", base: "https://511ga.org", region: CA(-85.7, 30.3, -80.7, 35.1) },
  { id: "cr-fl", label: "FL 511", kind: "cr-list", base: "https://fl511.com", region: CA(-87.7, 24.4, -79.9, 31.1) },
  { id: "cr-ak", label: "Alaska 511", kind: "cr-list", base: "https://511.alaska.gov", region: CA(-170, 54, -129, 71.5) },
  { id: "cr-ny", label: "511NY", kind: "cr-list", base: "https://511ny.org", region: CA(-79.8, 40.4, -71.8, 45.1) },
  { id: "cr-ct", label: "CT Roads", kind: "cr-list", base: "https://ctroads.org", region: CA(-73.8, 40.9, -71.8, 42.1) },
  { id: "cr-ut", label: "UDOT Traffic", kind: "cr-list", base: "https://www.udottraffic.utah.gov", region: CA(-114.1, 36.9, -109.0, 42.05) },
  // Castle Rock SPA GraphQL — bbox-native
  { id: "crg-mn", label: "511MN", kind: "cr-graphql", base: "https://511mn.org", region: CA(-97.3, 43.4, -89.4, 49.4) },
  { id: "crg-ia", label: "511IA", kind: "cr-graphql", base: "https://511ia.org", region: CA(-96.7, 40.3, -90.1, 43.6) },
  { id: "crg-ma", label: "Mass511", kind: "cr-graphql", base: "https://mass511.com", region: CA(-73.6, 41.1, -69.8, 43.0) },
  { id: "crg-in", label: "511IN", kind: "cr-graphql", base: "https://511in.org", region: CA(-88.1, 37.7, -84.7, 41.8) },
  { id: "crg-ks", label: "KanDrive", kind: "cr-graphql", base: "https://www.kandrive.gov", region: CA(-102.1, 36.9, -94.5, 40.1) },
  { id: "crg-ne", label: "Nebraska 511", kind: "cr-graphql", base: "https://511.nebraska.gov", region: CA(-104.1, 39.9, -95.2, 43.1) },
  { id: "crg-co", label: "COtrip", kind: "cr-graphql", base: "https://www.cotrip.org", region: CA(-109.1, 36.9, -102.0, 41.1) },
  // one-off state feeds
  { id: "deldot", label: "DelDOT", kind: "deldot", region: CA(-75.8, 38.4, -74.9, 39.9) },
  { id: "md-chart", label: "MD CHART", kind: "md-chart", region: CA(-79.5, 37.8, -74.9, 39.8) },
  { id: "oregon", label: "TripCheck (Oregon)", kind: "oregon", region: CA(-124.6, 41.9, -116.4, 46.3) },
  { id: "modot", label: "MoDOT", kind: "modot", region: CA(-95.8, 35.9, -89.0, 40.7) },
  { id: "tdot", label: "TDOT SmartWay (Tennessee)", kind: "tdot", region: CA(-90.4, 34.9, -81.6, 36.7) },
];

/** Providers whose coverage intersects the AOI. Pure — unit-tested in Phase 5. */
export function selectProviders(aoi: Bbox): CameraProvider[] {
  return CAMERA_PROVIDERS.filter((p) => bboxIntersects(p.region, aoi));
}

/** Turn normalized cameras into a MapLibre FeatureCollection. */
export function camerasToFC(cams: CameraFeature[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = cams.map((c) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [c.lng, c.lat] },
    properties: {
      id: c.id,
      label: c.label,
      provider: c.provider,
      imageUrl: c.imageUrl,
      streamUrl: c.streamUrl ?? "",
      embedUrl: c.embedUrl ?? "",
    },
  }));
  return { type: "FeatureCollection", features };
}
