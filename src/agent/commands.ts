import { layerManager } from "@/src/layers/registry";
import { useArgusStore } from "@/src/store/useArgusStore";
import type { Bbox } from "@/src/core/bbox";

/**
 * Typed command facade over the map + layers. The CommandBar and EntityPanel
 * already call the underlying LayerManager; this module is the stable surface a
 * v2 AI agent will tool-call (flyTo, toggle, query, describe). Keeping it thin
 * and side-effect-only means dropping in an LLM later needs no refactor.
 */
export const argusCommands = {
  /** All layers with their current enabled/status/count. */
  listLayers() {
    const state = useArgusStore.getState();
    return layerManager.listLayers().map((l) => {
      const rt = state.layers[l.id];
      return {
        id: l.id,
        label: l.label,
        enabled: rt?.enabled ?? false,
        status: rt?.status ?? "idle",
        count: rt?.count ?? 0,
      };
    });
  },

  toggleLayer(id: string, on: boolean) {
    layerManager.toggleLayer(id, on);
  },

  /** Cinematic camera move. */
  flyTo(lng: number, lat: number, zoom = 9, pitch = 0) {
    layerManager.flyTo({ center: [lng, lat], zoom, pitch });
  },

  /** Read a layer's data for a bbox without touching the camera. */
  queryLayer(id: string, bbox: Bbox) {
    return layerManager.queryLayer(id, bbox);
  },

  currentViewport() {
    return useArgusStore.getState().viewport;
  },

  currentSelection() {
    return useArgusStore.getState().selected;
  },

  /** Geocode a place name to coordinates (for "fly me to X" intents). */
  async searchPlace(q: string): Promise<{ name: string; lng: number; lat: number }[]> {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    return (await r.json()) as { name: string; lng: number; lat: number }[];
  },
};

export type ArgusCommands = typeof argusCommands;
