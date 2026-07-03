import type { Map as MlMap } from "maplibre-gl";
import { useArgusStore, type SourceStatus } from "@/src/store/useArgusStore";

// Situation report for the current AOI, built from what's actually rendered
// (querySourceFeatures) — the same ground truth the map shows. Consumed by
// SitrepPanel and the agent's situation_report tool.

export interface SitrepEvent {
  layerId: string;
  layerLabel: string;
  color: string;
  title: string;
  severity: number;
  center: [number, number];
  imageUrl?: string;
  streamUrl?: string;
  url?: string;
}

export interface SitrepLayerRow {
  id: string;
  label: string;
  color: string;
  count: number;
  status: SourceStatus;
  history: number[];
}

export interface Sitrep {
  layers: SitrepLayerRow[];
  topEvents: SitrepEvent[];
  headlines: SitrepEvent[];
  cameras: SitrepEvent[];
}

/** One-line auto-written intel brief for the focused area (no LLM — template
 *  over live counts; the agent expands it on demand). */
export function briefLine(rep: Sitrep): string {
  const parts = rep.layers
    .filter((l) => l.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((l) => `${l.count.toLocaleString()} ${l.label.toLowerCase()}`);
  if (!parts.length) return "No live events detected in the focused area yet.";
  const top = rep.topEvents[0];
  return (
    `Live now: ${parts.join(" · ")}.` +
    (top && top.severity >= 3 ? ` Most severe: ${top.title} (${top.layerLabel}).` : "")
  );
}

// count history ring buffer per layer (for sparklines), fed by store subscription
const HISTORY_LEN = 24;
const history = new Map<string, number[]>();
let subscribed = false;

function ensureHistorySub() {
  if (subscribed) return;
  subscribed = true;
  let last: Record<string, number> = {};
  useArgusStore.subscribe((s) => {
    for (const id of s.order) {
      const l = s.layers[id];
      if (!l?.enabled || l.count === last[id]) continue;
      last = { ...last, [id]: l.count };
      const h = history.get(id) ?? [];
      h.push(l.count);
      if (h.length > HISTORY_LEN) h.shift();
      history.set(id, h);
    }
  });
}

function featureEvents(map: MlMap, id: string, label: string, color: string): SitrepEvent[] {
  let feats;
  try {
    feats = map.querySourceFeatures(`${id}-src`);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: SitrepEvent[] = [];
  for (const f of feats) {
    const p = f.properties ?? {};
    if (p.point_count) continue;
    const title = String(p.title ?? p.name ?? p.place ?? "").trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const g = f.geometry;
    if (g.type !== "Point") continue;
    out.push({
      layerId: id,
      layerLabel: label,
      color,
      title,
      severity: Number(p.severity) || 0,
      center: [g.coordinates[0], g.coordinates[1]],
      imageUrl: typeof p.imageUrl === "string" ? p.imageUrl : undefined,
      streamUrl: typeof p.streamUrl === "string" ? p.streamUrl : undefined,
      url: typeof p.url === "string" ? p.url : undefined,
    });
  }
  return out;
}

export function buildSitrep(map: MlMap): Sitrep {
  ensureHistorySub();
  const s = useArgusStore.getState();
  const aoiCenter: [number, number] = s.aoi
    ? [(s.aoi.bbox.west + s.aoi.bbox.east) / 2, (s.aoi.bbox.south + s.aoi.bbox.north) / 2]
    : [0, 0];

  const layers: SitrepLayerRow[] = [];
  const all: SitrepEvent[] = [];
  for (const id of s.order) {
    const l = s.layers[id];
    if (!l?.enabled) continue;
    layers.push({
      id,
      label: l.label,
      color: l.color,
      count: l.count,
      status: l.status,
      history: history.get(id) ?? [],
    });
    all.push(...featureEvents(map, id, l.label, l.color));
  }

  const dist = (e: SitrepEvent) =>
    (e.center[0] - aoiCenter[0]) ** 2 + (e.center[1] - aoiCenter[1]) ** 2;

  return {
    layers,
    topEvents: all
      .filter((e) => e.layerId !== "cameras" && e.layerId !== "webcams")
      .sort((a, b) => b.severity - a.severity || dist(a) - dist(b))
      .slice(0, 10),
    headlines: all.filter((e) => e.layerId === "news").slice(0, 5),
    cameras: all
      .filter((e) => e.layerId === "cameras" || e.layerId === "webcams")
      .sort((a, b) => dist(a) - dist(b))
      .slice(0, 5),
  };
}
