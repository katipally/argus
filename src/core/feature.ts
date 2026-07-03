import type { Feature, Point } from "geojson";

/**
 * One normalized shape for every entity Argus renders, whatever the source.
 * Tooltip, EntityPanel, the event ticker, and the agent's query surface all read
 * this — so a quake, a news hotspot, and a wildfire are interchangeable to the UI.
 *
 * `severity` is a 0–4 scale (0 = info, 4 = critical) each layer maps its own
 * metric onto (quake magnitude, GDACS alert level, fire confidence, …). It drives
 * symbol size and the shared color ramp; the LAYER's accent color still identifies
 * which layer a feature belongs to.
 */
export interface ArgusProps {
  id: string;
  layerId: string;
  title: string;
  severity: number; // 0–4
  ts?: number; // event time, epoch ms
  /** Layer-specific extras, shown as rows in the panel. Flat, display-ready. */
  meta?: Record<string, string>;
  [k: string]: unknown;
}

export type ArgusFeature = Feature<Point, ArgusProps>;

/** Colorblind-safe severity ramp (blue→amber→red), paired with size so it never
 *  relies on hue alone. Used for cross-layer badges, the ticker, and heat tint. */
export const SEVERITY_RAMP = ["#4aa3ff", "#3fd0c9", "#f5c344", "#ff8a3d", "#fb5c8b"] as const;

export function severityColor(sev: number): string {
  return SEVERITY_RAMP[clampSeverity(sev)];
}

export function clampSeverity(sev: number): number {
  if (!Number.isFinite(sev)) return 0;
  return Math.max(0, Math.min(4, Math.round(sev)));
}

/** Build a valid ArgusFeature, dropping anything with an out-of-range coordinate. */
export function argusFeature(
  lng: number,
  lat: number,
  props: ArgusProps,
): ArgusFeature | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  // reject null-island (0,0) — almost always a missing-coordinate sentinel
  if (lng === 0 && lat === 0) return null;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { ...props, severity: clampSeverity(props.severity) },
  };
}
