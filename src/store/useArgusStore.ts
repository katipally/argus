import { create } from "zustand";
import type { Polygon, MultiPolygon } from "geojson";
import type { Viewport } from "@/src/layers/types";
import { type Bbox, geometryBbox, bufferBbox } from "@/src/core/bbox";

export type SourceStatus = "idle" | "loading" | "live" | "cached" | "down";

/** Street-imagery providers. Panoramax is keyless (default); Mapillary is an
 *  optional wider-coverage fallback that activates when a free token is set. */
export type PanoSource = "panoramax" | "mapillary";

export interface HoverInfo {
  x: number;
  y: number;
  title: string;
  rows: [string, string][];
  color: string;
}

export interface EntityInfo {
  layerId: string;
  title: string;
  subtitle?: string;
  rows: [string, string][];
  color: string;
  center: [number, number];
  imageUrl?: string;
  streamUrl?: string;
  /** Embeddable iframe URL (e.g. a YouTube Live broadcast) — shown in the panel. */
  embedUrl?: string;
  /** External source link (e.g. a news article) — opened from the panel. */
  url?: string;
}

export interface LayerState {
  id: string;
  label: string;
  color: string;
  group: string;
  enabled: boolean;
  count: number;
  status: SourceStatus;
  updatedAt: number | null;
  /** Short provenance cue, e.g. "3 sources" — shown in the HUD when set. */
  note?: string;
}

/** A clicked ground location whose place card is open (Google-Earth-style).
 *  Scope follows the map zoom at click time — the same bands double-click
 *  selection uses — so details and selection always resolve at the SAME level. */
export interface PlaceQuery {
  lat: number;
  lon: number;
  /** map zoom at right-click time (drives the Nominatim reverse level). */
  zoom?: number;
  /** instant-band scope resolved client-side from bundled data. */
  scopeKind?: "continent" | "country" | "ocean";
  scopeName?: string;
}

/** Area of Interest — nothing loads until one is set. Derived from `selection`. */
export interface Aoi {
  kind: "country" | "continent" | "ocean" | "region";
  label: string;
  bbox: Bbox;
  isoCodes?: string[]; // country NAMEs (kept for legacy highlight/fetch keying)
  /** Who set it — ScopePanel only auto-clears its own ("picks"). */
  source?: "picks" | "box" | "admin" | "agent";
}

/** One selected region carrying its REAL geometry (not just a bbox). */
export interface SelShape {
  id: string;
  kind: "country" | "admin" | "continent" | "ocean" | "eez" | "box" | "place";
  label: string;
  geometry: Polygon | MultiPolygon;
  /** country NAME (or place id) — used to match/toggle + EEZ lookup. */
  ref?: string;
}

/** "Notify me when a <layer> event of severity ≥ N appears." */
export interface WatchRule {
  id: string;
  layerId: string;
  minSeverity: number;
}

/** A pinned entity panel: floats geo-anchored to its map point (leader line),
 *  survives new selections — multi-camera / multi-event monitoring. dx/dy is
 *  the user-dragged offset from the projected anchor, in screen px. */
export interface PinnedPanel {
  id: string;
  entity: EntityInfo;
  dx: number;
  dy: number;
}

const WATCH_LS = "argus:watches";
function loadWatches(): WatchRule[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(WATCH_LS) ?? "[]") as WatchRule[];
  } catch {
    return [];
  }
}
function saveWatches(w: WatchRule[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(WATCH_LS, JSON.stringify(w));
}

const MAX_SHAPES = 40; // ponytail: sane cap so a runaway multi-select can't OOM the mask
const MAX_PINS = 24; // a serious camera wall; beyond this the map disappears

/** Derive the fetch/gating AOI from the current selection (antimeridian-safe). */
function aoiFromSelection(shapes: SelShape[]): Aoi | null {
  if (!shapes.length) return null;
  const bb = geometryBbox(shapes.map((s) => s.geometry));
  if (!bb) return null;
  const countries = shapes.filter((s) => s.kind === "country").map((s) => s.ref ?? s.label);
  const kind =
    shapes.length === 1
      ? (["country", "continent", "ocean"].includes(shapes[0].kind)
          ? (shapes[0].kind as Aoi["kind"])
          : "region")
      : "region";
  return {
    kind,
    label: shapes.length === 1 ? shapes[0].label : `${shapes.length} areas`,
    bbox: bufferBbox(bb, 0.12),
    isoCodes: countries.length ? countries : undefined,
    source: shapes.some((s) => s.kind === "box" || s.kind === "admin") ? "box" : "picks",
  };
}

export interface ViewOptions {
  projection: "globe" | "mercator";
  terrain: boolean;
  labels: boolean;
  /** dark matter (default) · positron light · Esri satellite. */
  basemap: "dark" | "light" | "satellite";
  buildings: boolean;
  /** live day/night terminator shading overlay. */
  daynight: boolean;
  /** epoch ms driving the terminator; null = follow real time. */
  clockMs: number | null;
}

// per-layer filter state; layers read these and apply MapLibre setFilter
export type Filters = {
  earthquakes: { minMag: number };
  planes: { minAlt: number; maxAlt: number; category: "all" | "mil" | "civ" };
  ships: { category: string; minSpeed: number };
  disasters: { types: string[]; alerts: string[] };
  hazards: { categories: string[] };
  radar: { opacity: number };
};

const DEFAULT_FILTERS: Filters = {
  earthquakes: { minMag: 0 },
  planes: { minAlt: 0, maxAlt: 60000, category: "all" },
  ships: { category: "all", minSpeed: 0 },
  disasters: {
    types: ["EQ", "TC", "FL", "DR", "VO", "WF", "TS"],
    alerts: ["Green", "Orange", "Red"],
  },
  hazards: { categories: ["Wildfires", "Severe Storms", "Volcanoes", "Sea and Lake Ice"] },
  radar: { opacity: 0.6 },
};

interface ArgusStore {
  layers: Record<string, LayerState>;
  order: string[];
  viewport: Viewport | null;
  hovered: HoverInfo | null;
  /** Selection hover-preview chip near the cursor ("FRANCE · 2×click"). */
  hoverHint: { x: number; y: number; text: string } | null;
  selected: EntityInfo | null;
  aoi: Aoi | null;
  /** Selected regions with real geometry — the source of truth for the AOI. */
  selection: SelShape[];
  place: PlaceQuery | null;
  /** Detail-workspace modal open for the current place. */
  detailOpen: boolean;
  /** Settings modal — which tab is open (null = closed). */
  settingsTab: "appearance" | "ai" | "watches" | "data" | "status" | null;
  /** Street-imagery still open in the full viewer (null = closed). Source-tagged
   *  so the viewer knows which provider (Panoramax keyless / Mapillary) to embed. */
  panoImageId: { id: string; source: PanoSource } | null;
  /** Clicked street-imagery dot: small thumb preview anchored at screen x/y. */
  panoPreview: { id: string; x: number; y: number; source: PanoSource } | null;
  /** Sitrep-row hover: map location to ring-highlight (leader tie). */
  tiePoint: [number, number] | null;
  /** 24h time playback: when active, ts-carrying layers replay up to `t`. */
  playback: { active: boolean; t: number };
  /** Watch rules — browser notification when a matching event appears. */
  watches: WatchRule[];
  /** Pinned floating entity panels (geo-anchored, draggable). */
  pinned: PinnedPanel[];
  view: ViewOptions;
  filters: Filters;

  registerLayer(m: {
    id: string;
    label: string;
    color: string;
    group: string;
    enabled: boolean;
  }): void;
  setEnabled(id: string, on: boolean): void;
  setLayerRuntime(
    id: string,
    p: Partial<Pick<LayerState, "count" | "status" | "updatedAt" | "note">>,
  ): void;
  setViewport(vp: Viewport): void;
  setHovered(h: HoverInfo | null): void;
  setHoverHint(h: { x: number; y: number; text: string } | null): void;
  setSelected(e: EntityInfo | null): void;
  setAoi(a: Aoi | null): void;
  setPlace(p: PlaceQuery | null): void;
  setDetailOpen(v: boolean): void;
  setSettingsTab(t: ArgusStore["settingsTab"]): void;
  setPanoImageId(p: { id: string; source: PanoSource } | null): void;
  setPanoPreview(p: { id: string; x: number; y: number; source: PanoSource } | null): void;
  setTiePoint(p: [number, number] | null): void;
  setPlayback(p: Partial<ArgusStore["playback"]>): void;
  addWatch(w: Omit<WatchRule, "id">): void;
  removeWatch(id: string): void;
  /** Pin an entity panel (dedupes by entity identity; capped). */
  addPin(entity: EntityInfo): void;
  removePin(id: string): void;
  movePin(id: string, dx: number, dy: number): void;
  setView(p: Partial<ViewOptions>): void;
  setFilter<K extends keyof Filters>(layer: K, patch: Partial<Filters[K]>): void;
  /** Add a shape. `additive` false (default) replaces the current selection. */
  addShape(shape: SelShape, additive?: boolean): void;
  removeShape(id: string): void;
  clearSelection(): void;
  setSelection(shapes: SelShape[]): void;
}

export const useArgusStore = create<ArgusStore>((set) => ({
  layers: {},
  order: [],
  viewport: null,
  hovered: null,
  hoverHint: null,
  selected: null,
  aoi: null,
  selection: [],
  place: null,
  detailOpen: false,
  settingsTab: null,
  panoImageId: null,
  panoPreview: null,
  tiePoint: null,
  playback: { active: false, t: 0 },
  watches: loadWatches(),
  pinned: [],
  view: {
    projection: "globe",
    terrain: false,
    labels: true,
    basemap: "dark",
    buildings: true,
    daynight: false,
    clockMs: null,
  },
  filters: DEFAULT_FILTERS,

  registerLayer: (m) =>
    set((s) =>
      s.layers[m.id]
        ? s
        : {
            layers: {
              ...s.layers,
              [m.id]: { ...m, count: 0, status: "idle", updatedAt: null },
            },
            order: [...s.order, m.id],
          },
    ),
  setEnabled: (id, on) =>
    set((s) =>
      s.layers[id]
        ? { layers: { ...s.layers, [id]: { ...s.layers[id], enabled: on } } }
        : s,
    ),
  setLayerRuntime: (id, p) =>
    set((s) =>
      s.layers[id]
        ? { layers: { ...s.layers, [id]: { ...s.layers[id], ...p } } }
        : s,
    ),
  setViewport: (vp) => set({ viewport: vp }),
  setHovered: (h) => set({ hovered: h }),
  setHoverHint: (h) => set({ hoverHint: h }),
  setSelected: (e) => set({ selected: e }),
  setAoi: (a) => set({ aoi: a, selected: null }),
  setPlace: (p) => set({ place: p, detailOpen: false }),
  setDetailOpen: (v) => set({ detailOpen: v }),
  setSettingsTab: (t) => set({ settingsTab: t }),
  setPanoImageId: (id) => set({ panoImageId: id }),
  setPanoPreview: (p) => set({ panoPreview: p }),
  setTiePoint: (p) => set({ tiePoint: p }),
  setPlayback: (p) => set((s) => ({ playback: { ...s.playback, ...p } })),
  addWatch: (w) =>
    set((s) => {
      const watches = [...s.watches, { ...w, id: `w${Date.now()}` }];
      saveWatches(watches);
      return { watches };
    }),
  removeWatch: (id) =>
    set((s) => {
      const watches = s.watches.filter((x) => x.id !== id);
      saveWatches(watches);
      return { watches };
    }),
  addPin: (entity) =>
    set((s) => {
      const id = `${entity.layerId}:${entity.title}`;
      if (s.pinned.some((p) => p.id === id)) return s;
      // stagger fresh pins in a loose grid around the anchor so a burst of
      // pins fans out instead of stacking (user drags refine from there)
      const i = s.pinned.length;
      const col = i % 4;
      const row = Math.floor(i / 4) % 3;
      const pin: PinnedPanel = { id, entity, dx: 32 + col * 22 - row * 10, dy: -88 - row * 30 - col * 12 };
      return { pinned: [...s.pinned, pin].slice(-MAX_PINS) };
    }),
  removePin: (id) => set((s) => ({ pinned: s.pinned.filter((p) => p.id !== id) })),
  movePin: (id, dx, dy) =>
    set((s) => ({ pinned: s.pinned.map((p) => (p.id === id ? { ...p, dx, dy } : p)) })),
  setView: (p) => set((s) => ({ view: { ...s.view, ...p } })),
  setFilter: (layer, patch) =>
    set((s) => ({ filters: { ...s.filters, [layer]: { ...s.filters[layer], ...patch } } })),
  addShape: (shape, additive = false) =>
    set((s) => {
      // toggle: clicking an already-selected shape removes it
      if (additive && s.selection.some((x) => x.id === shape.id)) {
        const sel = s.selection.filter((x) => x.id !== shape.id);
        return { selection: sel, aoi: aoiFromSelection(sel), selected: null };
      }
      const base = additive ? s.selection : [];
      const sel = [...base.filter((x) => x.id !== shape.id), shape].slice(-MAX_SHAPES);
      return { selection: sel, aoi: aoiFromSelection(sel), selected: null };
    }),
  removeShape: (id) =>
    set((s) => {
      const sel = s.selection.filter((x) => x.id !== id);
      return { selection: sel, aoi: aoiFromSelection(sel), selected: null };
    }),
  clearSelection: () => set({ selection: [], aoi: null, selected: null }),
  setSelection: (shapes) =>
    set(() => {
      const sel = shapes.slice(-MAX_SHAPES);
      return { selection: sel, aoi: aoiFromSelection(sel), selected: null };
    }),
}));
