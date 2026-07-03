import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LayerModule, Viewport } from "./types";
import type { Bbox } from "@/src/core/bbox";
import { debounce } from "@/src/core/debounce";
import { useArgusStore } from "@/src/store/useArgusStore";

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Minimal view of the map the manager needs — lets tests use a fake. */
export interface MapLike {
  getZoom(): number;
  getBounds(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  };
  on(type: "idle", cb: () => void): unknown;
  off(type: "idle", cb: () => void): unknown;
  flyTo?(opts: unknown): unknown;
}

/**
 * The lazy-loading brain. Registers layer modules, then on every map-idle:
 * reads the viewport, and for each ENABLED layer above its minZoom, kicks a
 * bbox-bound update(). No timers — movement drives everything, debounced.
 */
export class LayerManager {
  private layers = new Map<string, LayerModule>();
  private map: MapLike | null = null;
  private tick = debounce(() => this.refresh(), 400);
  private selRaf: number | null = null;

  register(layer: LayerModule): void {
    this.layers.set(layer.id, layer);
    useArgusStore.getState().registerLayer({
      id: layer.id,
      label: layer.label,
      color: layer.color,
      group: layer.group,
      enabled: layer.defaultEnabled,
    });
  }

  async start(map: MapLike): Promise<void> {
    this.map = map;
    for (const layer of this.layers.values()) {
      await layer.init(map as unknown as MlMap);
      layer.setVisible(layer.defaultEnabled);
    }
    try {
      this.initSelectionPulse(map as unknown as MlMap);
    } catch {
      /* non-DOM map (unit tests) — skip the pulse */
    }
    // reload/clear layers whenever the AOI or filters change. Flip active layers
    // to `loading` first so the HUD shows "syncing" during the big refetch (a new
    // AOI is exactly when the user wants to see work happening).
    useArgusStore.subscribe((state, prev) => {
      if (state.aoi !== prev.aoi || state.filters !== prev.filters) {
        if (state.aoi) {
          for (const layer of this.layers.values()) {
            if (state.layers[layer.id]?.enabled) {
              state.setLayerRuntime(layer.id, { status: "loading" });
            }
          }
        }
        this.refresh();
      }
    });
    map.on("idle", this.tick);
    // Pause work while the tab is hidden (battery + upstream politeness), refresh
    // immediately on return so data is fresh the moment the user looks back.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    this.refresh();
  }

  private onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      this.refresh();
    }
  };

  /** MapLibre-native pulsing ring on the selected entity (always aligned). */
  private initSelectionPulse(map: MlMap): void {
    if (typeof map.addSource !== "function") return;
    map.addSource("sel-src", { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: "sel-ring",
      type: "circle",
      source: "sel-src",
      paint: {
        "circle-radius": 18,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#38e0ff",
        "circle-stroke-width": 2,
        "circle-stroke-opacity": 0.8,
      },
    });
    map.addLayer({
      id: "sel-core",
      type: "circle",
      source: "sel-src",
      paint: { "circle-radius": 3.5, "circle-color": "#38e0ff" },
    });

    let phase = 0;
    const animate = () => {
      phase += 0.045;
      map.setPaintProperty("sel-ring", "circle-radius", 16 + 9 * (0.5 + 0.5 * Math.sin(phase)));
      map.setPaintProperty("sel-ring", "circle-stroke-opacity", 0.25 + 0.55 * (0.5 + 0.5 * Math.cos(phase)));
      this.selRaf = requestAnimationFrame(animate);
    };

    useArgusStore.subscribe((state, prev) => {
      if (state.selected === prev.selected) return;
      const src = map.getSource("sel-src") as GeoJSONSource | undefined;
      if (!src) return;
      const sel = state.selected;
      if (sel) {
        src.setData({
          type: "FeatureCollection",
          features: [
            { type: "Feature", geometry: { type: "Point", coordinates: sel.center }, properties: {} },
          ],
        });
        map.setPaintProperty("sel-ring", "circle-stroke-color", sel.color);
        map.setPaintProperty("sel-core", "circle-color", sel.color);
        if (this.selRaf == null) animate();
      } else {
        src.setData(EMPTY_FC);
        if (this.selRaf != null) {
          cancelAnimationFrame(this.selRaf);
          this.selRaf = null;
        }
      }
    });
  }

  currentViewport(): Viewport {
    const b = this.map!.getBounds();
    return {
      zoom: this.map!.getZoom(),
      bbox: {
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      },
    };
  }

  refresh(): void {
    if (!this.map) return;
    // Don't kick fetches while the tab is hidden — onVisibility refreshes on return.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const vp = this.currentViewport();
    const store = useArgusStore.getState();
    store.setViewport(vp);
    const hasAoi = !!store.aoi;

    for (const layer of this.layers.values()) {
      const rt = store.layers[layer.id];
      const enabled = rt?.enabled ?? layer.defaultEnabled;
      // `active` = should this layer be loading/streaming at all. AOI-gated, except
      // street layers (viewportFallback) also load for the current view once zoomed
      // in — so you can browse streets without picking an AOI first.
      const active =
        enabled && (hasAoi || (!!layer.viewportFallback && vp.zoom >= layer.minZoom));
      // zoom only controls VISIBILITY (streams keep running, hidden)
      layer.setVisible(active && vp.zoom >= layer.minZoom);
      // Surface "we're fetching" the moment a first activation starts — the user
      // asked never to stare at emptiness. Only on the idle→active transition, so
      // established layers don't flicker a spinner on every pan (AOI/filter changes
      // set `loading` explicitly in the store subscription above).
      if (active && rt?.status === "idle") {
        store.setLayerRuntime(layer.id, { status: "loading" });
      }
      void layer.update(vp, active);
    }
  }

  /** Frame a bbox (used when an AOI is selected). */
  fitBbox(bbox: Bbox, opts: { padding?: number; pitch?: number } = {}): void {
    const m = this.map as unknown as {
      fitBounds?: (b: [[number, number], [number, number]], o: object) => void;
    };
    // Antimeridian wrap: east < west means the box crosses ±180 — unwrap east
    // past 180 so fitBounds frames the short way around, not the whole globe.
    const east = bbox.east < bbox.west ? bbox.east + 360 : bbox.east;
    m.fitBounds?.(
      [
        [bbox.west, bbox.south],
        [east, bbox.north],
      ],
      { padding: opts.padding ?? 80, duration: 1600, pitch: opts.pitch ?? 0, essential: true },
    );
  }

  // ── Command surface (used by the HUD now, the AI agent in v2) ──
  toggleLayer(id: string, on: boolean): void {
    useArgusStore.getState().setEnabled(id, on);
    this.refresh();
  }

  flyTo(opts: { center?: [number, number]; zoom?: number; pitch?: number }): void {
    this.map?.flyTo?.({ duration: 2200, essential: true, ...opts });
  }

  queryLayer(id: string, bbox: Bbox, filters?: Record<string, unknown>) {
    return this.layers.get(id)?.query?.(bbox, filters);
  }

  listLayers() {
    return [...this.layers.values()].map((l) => ({ id: l.id, label: l.label }));
  }

  destroy(): void {
    if (this.map) this.map.off("idle", this.tick);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.tick.cancel();
    if (this.selRaf != null) {
      cancelAnimationFrame(this.selRaf);
      this.selRaf = null;
    }
    for (const layer of this.layers.values()) layer.destroy();
    this.layers.clear();
    this.map = null;
  }
}
