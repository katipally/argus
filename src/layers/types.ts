import type { Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { Bbox } from "@/src/core/bbox";

export type { Bbox };

export interface Viewport {
  bbox: Bbox;
  zoom: number;
}

/**
 * Every data source is one self-contained module implementing this interface.
 * The LayerManager drives them; the future AI agent drives the same surface.
 */
/** HUD grouping — the LayerRail renders one collapsible section per group. */
export type LayerGroup = "earth" | "sky" | "signals" | "movement" | "ground";

export interface LayerModule {
  id: string;
  label: string;
  /** Neon accent used in the HUD and for markers. */
  color: string;
  /** Which LayerRail section this layer lives in. */
  group: LayerGroup;
  /** LOD gate — the manager skips fetch/render below this zoom. */
  minZoom: number;
  /** Hard cap on rendered features (anti-crash). */
  maxFeatures: number;
  defaultEnabled: boolean;
  /**
   * Street-level layers set this: when no AOI is chosen, they still load for the
   * CURRENT viewport once zoomed in past minZoom — so "zoom into a city → see it"
   * works without picking an AOI first. Global layers leave it off (an unbounded
   * viewport would fetch the whole world).
   */
  viewportFallback?: boolean;

  /** Add MapLibre sources/layers + wire interactions. Called once. */
  init(map: MlMap): void | Promise<void>;
  /**
   * `load=false` means "not active right now" (no AOI, disabled zoom, etc.) —
   * the layer must clear/stop and render nothing. `load=true` means fetch+render
   * constrained to the current AOI. Reads the AOI from the store. Never throws.
   */
  update(vp: Viewport, load: boolean): Promise<void>;
  /** Pure read for a bbox — the agent's query surface. Optional. */
  query?(bbox: Bbox, filters?: Record<string, unknown>): Promise<FeatureCollection>;
  setVisible(visible: boolean): void;
  destroy(): void;
}
