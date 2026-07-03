import type { Map as MlMap } from "maplibre-gl";
import { useArgusStore, type EntityInfo } from "@/src/store/useArgusStore";
import { geomCenter } from "@/src/layers/interactions";

// Shared entity access for the agent: read the LIVE rendered features of any
// layer (the same dots a user sees), match/filter them, and turn one into an
// EntityPanel selection — the exact path a click takes, so "select that ship"
// works like clicking it, and keeps working as the ship moves.

const w = () => (window as unknown as { argusMap?: MlMap }).argusMap;

/** Layers whose entities move between frames (dead-reckoned) — trackable. */
export const MOVEMENT_LAYERS = new Set(["planes", "ships"]);

export interface EntityRow {
  id: string;
  title: string;
  center: [number, number];
  props: Record<string, unknown>;
}

const isScalar = (v: unknown) => v != null && typeof v !== "object";

function featTitle(p: Record<string, unknown>): string {
  return String(p.title ?? p.name ?? p.flight ?? p.place ?? p.label ?? p.headline ?? p.id ?? "").trim();
}

export function layerColor(layerId: string): string {
  return useArgusStore.getState().layers[layerId]?.color ?? "#38e0ff";
}

/**
 * Read a layer's currently-rendered entities from its live GeoJSON source.
 * Skips cluster bubbles (point_count) and de-dupes by stable id. `query` does a
 * loose case-insensitive match over the title + all properties.
 */
export function readEntities(layerId: string, opts: { query?: string; limit?: number } = {}): EntityRow[] {
  const map = w();
  if (!map) return [];
  const limit = opts.limit ?? 40;
  const q = opts.query?.trim().toLowerCase();
  const seen = new Set<string>();
  const out: EntityRow[] = [];
  let feats;
  try {
    feats = map.querySourceFeatures(`${layerId}-src`);
  } catch {
    return [];
  }
  for (const f of feats) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (p.point_count) continue; // cluster, not an individual entity
    const title = featTitle(p);
    const id = String(p.id ?? title);
    if (!id || seen.has(id)) continue;
    if (q && !`${title} ${JSON.stringify(p)}`.toLowerCase().includes(q)) continue;
    seen.add(id);
    out.push({ id, title: title || id, center: geomCenter(f.geometry), props: p });
    if (out.length >= limit) break;
  }
  return out;
}

const n = (v: unknown) => (v == null || v === "" ? null : Number(v));

/** Build the EntityPanel selection for one entity — nice rows for the layers the
 *  user cares about, a generic scalar dump otherwise. Layer-agnostic + live-safe. */
export function describeEntity(layerId: string, e: EntityRow): EntityInfo {
  const p = e.props;
  const base = { layerId, title: e.title || "Entity", color: layerColor(layerId), center: e.center };
  let subtitle: string | undefined;
  let rows: [string, string][];

  if (layerId === "planes") {
    subtitle = `ADS-B · live${Number(p.mil) ? " · MIL" : ""}`;
    rows = [
      ["Type", String(p.craft || "—")],
      ["Route", p.from || p.to ? `${p.from || "?"} → ${p.to || "?"}` : "—"],
      ["Altitude", n(p.alt) != null ? `${Number(p.alt).toLocaleString()} ft` : "—"],
      ["Ground spd", n(p.gs) != null ? `${Math.round(Number(p.gs))} kt` : "—"],
      ["Track", `${Math.round(Number(p.track ?? 0))}°`],
    ];
  } else if (layerId === "ships") {
    subtitle = `AIS · ${p.cat ?? "vessel"}`;
    rows = [
      ["Type", String(p.cat ?? "—")],
      ["Speed", n(p.sog) != null ? `${Number(p.sog).toFixed(1)} kn` : "—"],
      ["Course", `${Math.round(Number(p.cog ?? 0))}°`],
      ["Destination", String(p.dest || "—")],
    ];
  } else {
    rows = Object.entries(p)
      .filter(([k, v]) => isScalar(v) && k !== "id" && !k.startsWith("_") && v !== "")
      .slice(0, 6)
      .map(([k, v]) => [k, String(v)] as [string, string]);
  }

  const info: EntityInfo = { ...base, subtitle, rows };
  if (typeof p.imageUrl === "string" && p.imageUrl) info.imageUrl = p.imageUrl;
  if (typeof p.streamUrl === "string" && p.streamUrl) info.streamUrl = p.streamUrl;
  if (typeof p.url === "string" && p.url) info.url = p.url;
  return info;
}

// ── attribute filtering (the agent's "filter any data" surface) ───────────────

export type Cond = string | number | boolean | { min?: number; max?: number; eq?: string | number; contains?: string };

/** Does one entity's props satisfy every condition in `where`? Strings match as
 *  case-insensitive substrings; numbers loose-equal; objects do min/max/eq/contains. */
export function matchEntity(props: Record<string, unknown>, where: Record<string, Cond>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const v = props[key];
    if (cond !== null && typeof cond === "object") {
      const num = Number(v);
      if (cond.min != null && !(num >= cond.min)) return false;
      if (cond.max != null && !(num <= cond.max)) return false;
      if (cond.eq != null && String(v).toLowerCase() !== String(cond.eq).toLowerCase()) return false;
      if (cond.contains != null && !String(v ?? "").toLowerCase().includes(cond.contains.toLowerCase())) return false;
    } else if (typeof cond === "number") {
      if (Number(v) !== cond) return false;
    } else if (typeof cond === "boolean") {
      if (Boolean(Number(v)) !== cond) return false;
    } else {
      if (!String(v ?? "").toLowerCase().includes(String(cond).toLowerCase())) return false;
    }
  }
  return true;
}
