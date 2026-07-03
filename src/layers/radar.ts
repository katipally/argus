import type { Map as MlMap } from "maplibre-gl";
import type { LayerModule, Viewport } from "./types";
import { useArgusStore } from "@/src/store/useArgusStore";

// Live precipitation radar (RainViewer). A raster overlay, not a point layer —
// MapLibre streams the PNG tiles per viewport, so there's no bbox fetch. We just
// refresh the frame index every few minutes to keep the "latest" frame current.
const COLOR = "#4aa3ff";
const SRC = "radar-src";
const LYR = "radar-layer";

let mapRef: MlMap | null = null;
let lastPath = "";
let fetchedAt = 0;

interface RvFrame {
  time: number;
  path: string;
}

async function latestFrame(): Promise<{ host: string; frame: RvFrame } | null> {
  const res = await fetch("/api/rainviewer");
  if (!res.ok) throw new Error(`rainviewer ${res.status}`);
  const d = (await res.json()) as { host: string; frames: RvFrame[] };
  const frame = d.frames.at(-1); // most recent
  return frame ? { host: d.host, frame } : null;
}

function tileUrl(host: string, path: string): string {
  // {host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth_snow}.png — scheme 4 (Universal Blue), smooth on
  return `${host}${path}/256/{z}/{x}/{y}/4/1_1.png`;
}

export const radar: LayerModule = {
  id: "radar",
  label: "Radar",
  color: COLOR,
  group: "sky",
  minZoom: 0,
  maxFeatures: 0,
  defaultEnabled: false,
  viewportFallback: true, // global overlay — show whenever enabled, no AOI needed

  init(map) {
    mapRef = map;
  },

  async update(_vp: Viewport, load: boolean) {
    const store = useArgusStore.getState();
    if (!mapRef) return;
    if (!load) {
      if (mapRef.getLayer(LYR)) mapRef.setLayoutProperty(LYR, "visibility", "none");
      store.setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    // refresh the frame index at most every 4 min
    if (!lastPath || Date.now() - fetchedAt > 4 * 60_000) {
      try {
        const latest = await latestFrame();
        if (latest && latest.frame.path !== lastPath) {
          lastPath = latest.frame.path;
          fetchedAt = Date.now();
          const url = tileUrl(latest.host, latest.frame.path);
          if (mapRef.getLayer(LYR)) mapRef.removeLayer(LYR);
          if (mapRef.getSource(SRC)) mapRef.removeSource(SRC);
          mapRef.addSource(SRC, {
            type: "raster",
            tiles: [url],
            tileSize: 256,
            attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
          });
          // insert below basemap labels for a clean look
          const style = mapRef.getStyle();
          const beforeSym = style.layers?.find((l) => l.type === "symbol")?.id;
          mapRef.addLayer(
            { id: LYR, type: "raster", source: SRC, paint: { "raster-opacity": store.filters.radar?.opacity ?? 0.6 } },
            beforeSym,
          );
        }
      } catch {
        store.setLayerRuntime(this.id, { count: 0, status: "down" });
        return;
      }
    }
    if (mapRef.getLayer(LYR)) {
      mapRef.setLayoutProperty(LYR, "visibility", "visible");
      mapRef.setPaintProperty(LYR, "raster-opacity", store.filters.radar?.opacity ?? 0.6);
    }
    store.setLayerRuntime(this.id, { count: 1, status: "live", updatedAt: fetchedAt });
  },

  setVisible(visible) {
    if (mapRef?.getLayer(LYR)) {
      mapRef.setLayoutProperty(LYR, "visibility", visible ? "visible" : "none");
    }
  },

  destroy() {
    if (mapRef?.getLayer(LYR)) mapRef.removeLayer(LYR);
    if (mapRef?.getSource(SRC)) mapRef.removeSource(SRC);
    mapRef = null;
    lastPath = "";
  },
};
