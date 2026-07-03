import type { MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import { createHotspotRender, type HotspotRender } from "@/src/core/aggregate";
import { argusFeature, type ArgusFeature } from "@/src/core/feature";
import { pointCenter } from "./interactions";
import { useArgusStore } from "@/src/store/useArgusStore";

// Live Wikipedia edit pulse (keyless). Streams geotagged English-Wikipedia
// article edits from the /api/wikipulse SSE bridge and shows a rolling window
// of the last few minutes — a real-time map of where the encyclopedia is being
// written. Global (viewportFallback), so it works at world zoom with no AOI.
const COLOR = "#facc15";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const WINDOW_MS = 8 * 60_000; // keep edits visible for 8 minutes

interface Edit {
  title: string;
  lng: number;
  lat: number;
  user: string;
  url: string;
  ts: number;
}

const edits = new Map<string, Edit>(); // keyed by title (newest wins)
let render: HotspotRender | null = null;
let es: EventSource | null = null;

function severity(ts: number): number {
  const age = Date.now() - ts;
  if (age < 60_000) return 3; // last minute
  if (age < 3 * 60_000) return 2;
  return 1;
}

function rebuild() {
  if (!render) return;
  const now = Date.now();
  for (const [k, e] of edits) if (now - e.ts > WINDOW_MS) edits.delete(k);
  const feats: ArgusFeature[] = [];
  for (const e of edits.values()) {
    const af = argusFeature(e.lng, e.lat, {
      id: `wiki-${e.title}`,
      layerId: "wikipulse",
      title: e.title,
      severity: severity(e.ts),
      user: e.user,
      url: e.url,
      ts: e.ts,
    });
    if (af) feats.push(af);
  }
  render.setData({ type: "FeatureCollection", features: feats.slice(-wikipulse.maxFeatures) });
  useArgusStore.getState().setLayerRuntime("wikipulse", {
    count: edits.size,
    status: "live",
    updatedAt: now,
    note: "Wikimedia",
  });
}

function startStream() {
  stopStream();
  es = new EventSource("/api/wikipulse");
  es.onmessage = (ev) => {
    let data: unknown;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data && typeof data === "object" && "ping" in data) return;
    if (data && typeof data === "object" && "error" in data) {
      useArgusStore.getState().setLayerRuntime("wikipulse", { status: "down" });
      return;
    }
    if (!Array.isArray(data)) return;
    const now = Date.now();
    for (const e of data as Array<Record<string, number | string>>) {
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      edits.set(String(e.title), {
        title: String(e.title),
        lng: e.lon as number,
        lat: e.lat as number,
        user: String(e.user ?? "?"),
        url: String(e.url ?? ""),
        ts: Number(e.ts) || now,
      });
    }
    rebuild();
  };
  es.onerror = () => {
    // EventSource auto-reconnects; flag the gap.
    useArgusStore.getState().setLayerRuntime("wikipulse", { status: "down" });
  };
}

function stopStream() {
  if (es) {
    es.close();
    es = null;
  }
  edits.clear();
  render?.setData(EMPTY);
}

function describe(f: MapGeoJSONFeature) {
  const p = f.properties ?? {};
  const t = typeof p.ts === "number" ? new Date(p.ts).toUTCString() : "—";
  return {
    title: String(p.title ?? "Wikipedia edit"),
    subtitle: `Wikipedia · edited by ${String(p.user ?? "?")}`,
    color: COLOR,
    center: pointCenter(f),
    url: String(p.url ?? ""),
    rows: [
      ["Editor", String(p.user || "—")],
      ["Edited (UTC)", t],
    ] as [string, string][],
  };
}

export const wikipulse: LayerModule = {
  id: "wikipulse",
  label: "Wiki pulse",
  color: COLOR,
  group: "signals",
  minZoom: 0,
  maxFeatures: 400,
  defaultEnabled: false,
  viewportFallback: true, // global live pulse — no AOI needed

  init(map) {
    render = createHotspotRender(map, { id: "wikipulse", color: COLOR, describe, heatUntil: 2, clusterMaxZoom: 3 });
  },

  async update(_vp: Viewport, load: boolean) {
    if (!load) {
      stopStream();
      useArgusStore.getState().setLayerRuntime(this.id, { count: 0, status: "idle" });
      return;
    }
    if (!es) {
      useArgusStore.getState().setLayerRuntime(this.id, { status: "loading" });
      startStream();
    }
  },

  setVisible(visible) {
    render?.setVisible(visible);
  },

  destroy() {
    stopStream();
    render?.destroy();
    render = null;
  },
};
