import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { type Bbox, fetchBbox, pointInBbox } from "@/src/core/bbox";
import { attachEntityInteractions, pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";
import {
  type CameraFeature,
  camerasToFC,
  selectProviders,
} from "./feeds/camera-providers";
import { curatedWebcams } from "./feeds/webcam-catalog";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const MAX_PROVIDERS = 12; // cap upstream fan-out per AOI (anti-crash)

interface CameraLayerConfig {
  id: string;
  label: string;
  color: string;
  minZoom: number;
  /** Fetch normalized cameras for the AOI. Never throws. */
  fetchCams(aoi: Bbox): Promise<CameraFeature[]>;
}

function createCameraLayer(cfg: CameraLayerConfig): LayerModule {
  const SRC = `${cfg.id}-src`;
  const LYR = `${cfg.id}-dots`;
  let mapRef: MlMap | null = null;

  return {
    id: cfg.id,
    label: cfg.label,
    color: cfg.color,
    group: "ground",
    minZoom: cfg.minZoom,
    maxFeatures: 1500,
    defaultEnabled: false,
    viewportFallback: true,

    init(map) {
      mapRef = map;
      map.addSource(SRC, { type: "geojson", data: EMPTY });
      map.addLayer({
        id: LYR,
        type: "circle",
        source: SRC,
        paint: {
          "circle-radius": 5,
          "circle-color": cfg.color,
          "circle-opacity": 0.9,
          "circle-stroke-color": "#04060b",
          "circle-stroke-width": 1.5,
        },
      });

      attachEntityInteractions(map, LYR, this.id, (f) => {
        const p = f.properties ?? {};
        return {
          title: String(p.label ?? "Camera"),
          subtitle: `${String(p.provider ?? "")} · live`,
          color: cfg.color,
          center: pointCenter(f),
          imageUrl: String(p.imageUrl ?? ""),
          streamUrl: p.streamUrl ? String(p.streamUrl) : undefined,
          embedUrl: p.embedUrl ? String(p.embedUrl) : undefined,
          rows: [
            ["Source", String(p.provider ?? "—")],
            ["Feed", p.embedUrl ? "live embed" : p.streamUrl ? "image + stream" : "image"],
          ] as [string, string][],
        };
      });
    },

    async update(_vp: Viewport, load: boolean) {
      const store = useArgusStore.getState();
      const bbox = fetchBbox(store.aoi?.bbox ?? null, store.viewport?.bbox ?? null);
      if (!load || !bbox) {
        (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY);
        store.setLayerRuntime(this.id, { count: 0, status: "idle" });
        return;
      }
      let cams: CameraFeature[] = [];
      try {
        cams = await cfg.fetchCams(bbox);
        store.setLayerRuntime(this.id, { status: "live", updatedAt: Date.now() });
      } catch {
        store.setLayerRuntime(this.id, { status: "down" });
      }
      const within = cams
        .filter((c) => pointInBbox(c.lng, c.lat, bbox))
        .slice(0, this.maxFeatures);
      (mapRef?.getSource(SRC) as GeoJSONSource | undefined)?.setData(camerasToFC(within));
      store.setLayerRuntime(this.id, { count: within.length });
    },

    setVisible(visible) {
      if (mapRef?.getLayer(LYR)) {
        mapRef.setLayoutProperty(LYR, "visibility", visible ? "visible" : "none");
      }
    },

    destroy() {
      if (!mapRef) return;
      if (mapRef.getLayer(LYR)) mapRef.removeLayer(LYR);
      if (mapRef.getSource(SRC)) mapRef.removeSource(SRC);
      mapRef = null;
    },
  };
}

// Keyless traffic cameras (Caltrans today). Queries only districts covering the AOI.
async function fetchTrafficCams(aoi: Bbox): Promise<CameraFeature[]> {
  const providers = selectProviders(aoi)
    .filter((p) => !p.keyed)
    .slice(0, MAX_PROVIDERS);
  const bb = `${aoi.west},${aoi.south},${aoi.east},${aoi.north}`;
  const results = await Promise.all(
    providers.map(async (p) => {
      try {
        const r = await fetch(`/api/cameras?provider=${encodeURIComponent(p.id)}&bbox=${bb}`);
        if (!r.ok) return [];
        const d = (await r.json()) as { cameras?: CameraFeature[] };
        return d.cameras ?? [];
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

export const cameras = createCameraLayer({
  id: "cameras",
  label: "Cameras",
  color: "#7dd3fc",
  minZoom: 7,
  fetchCams: fetchTrafficCams,
});

// Global webcams: curated 24/7 YouTube Lives (keyless, always available) +
// Windy's worldwide network when a free WINDY_API_KEY is set. Sparser than DOT
// cams, so it appears at country zoom rather than city zoom.
async function fetchWebcams(aoi: Bbox): Promise<CameraFeature[]> {
  const curated = curatedWebcams(aoi);
  try {
    const bb = `${aoi.west},${aoi.south},${aoi.east},${aoi.north}`;
    const r = await fetch(`/api/webcams?bbox=${bb}`);
    if (!r.ok) return curated;
    const d = (await r.json()) as { cameras?: CameraFeature[]; keyless?: boolean };
    if (d.keyless) {
      useArgusStore.getState().setLayerRuntime("webcams", { note: "free Windy key adds global cams" });
    }
    return [...curated, ...(d.cameras ?? [])];
  } catch {
    return curated;
  }
}

export const webcams = createCameraLayer({
  id: "webcams",
  label: "Webcams",
  color: "#f0abfc",
  minZoom: 4,
  fetchCams: fetchWebcams,
});
