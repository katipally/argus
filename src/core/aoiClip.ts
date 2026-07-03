import { useArgusStore, type SelShape } from "@/src/store/useArgusStore";
import { iso2ForName } from "@/src/geo/countries";
import {
  bufferBbox,
  pointInBbox,
  distToGeometryDeg,
  pointInGeometry,
  type Bbox,
} from "./bbox";

// One place decides "is this entity related to the selected region?" — reused by
// the hotspot pipeline (aggregate.ts) and the streaming movement layers
// (planes/ships). Two notions of related:
//   • spatial  — the entity is physically IN the selected shape (or within a
//     halo: coastal waters / bordering airspace).
//   • route    — a plane's origin/dest airport, or a ship's declared
//     destination, resolves to the selected country (Germany→India flight is
//     "related to India" even while it's over Iran — as far as we can see it).

export interface AoiClip {
  /** buffered bbox for a cheap first-pass reject before the polygon test. */
  bb: Bbox;
  shapes: SelShape[];
  /** halo in degrees added around each shape (coastal/airspace margin). */
  margin: number;
  /** ISO_A2 of every selected country shape (for ship-destination matching). */
  countryIso2: Set<string>;
  /** lowercased names of every selected country (destination substring match). */
  countryNames: string[];
}

/**
 * Build a clip from the current selection, or null when nothing is selected —
 * in which case callers show everything (viewport browsing). `marginDeg` widens
 * the shape: use a small halo for planes (airspace hugs the border) and a
 * larger one for ships (their traffic sits offshore in coastal waters).
 */
export function currentAoiClip(marginDeg: number): AoiClip | null {
  const st = useArgusStore.getState();
  if (!st.aoi || st.selection.length === 0) return null;
  const iso2 = new Set<string>();
  const names: string[] = [];
  for (const s of st.selection) {
    if (s.kind !== "country") continue;
    const nm = s.ref ?? s.label;
    names.push(nm.toLowerCase());
    const code = iso2ForName(nm);
    if (code) iso2.add(code);
  }
  return {
    bb: bufferBbox(st.aoi.bbox, 0, marginDeg),
    shapes: st.selection,
    margin: marginDeg,
    countryIso2: iso2,
    countryNames: names,
  };
}

/** True if the point is inside the selection (any shape) or within its halo. */
export function inClip(lng: number, lat: number, clip: AoiClip): boolean {
  if (!pointInBbox(lng, lat, clip.bb)) return false; // clearly far → drop fast
  for (const s of clip.shapes) {
    if (distToGeometryDeg(lng, lat, s.geometry) <= clip.margin) return true;
  }
  return false;
}

/** True if a point (an origin/dest airport) lies strictly inside any selected
 *  shape — route-relatedness, no halo since airports sit inland. */
export function airportInClip(lng: number, lat: number, clip: AoiClip): boolean {
  for (const s of clip.shapes) {
    if (pointInGeometry(lng, lat, s.geometry)) return true;
  }
  return false;
}

/**
 * Does an AIS destination string name a selected country? Best-effort:
 *   1. UN/LOCODE prefix — "INBOM", "IN BOM" → country ISO2 "IN".
 *   2. substring — dest text contains the country name ("MUMBAI,INDIA").
 * ponytail: bare port names ("MUMBAI") need a port→country table we don't ship;
 * the spatial in-waters test is the reliable path, this only adds arrivals.
 */
export function destMatchesCountry(dest: string, clip: AoiClip): boolean {
  const d = dest.trim().toUpperCase();
  if (!d) return false;
  const loc = /^([A-Z]{2})\s?[A-Z0-9]{3}\b/.exec(d);
  if (loc && clip.countryIso2.has(loc[1])) return true;
  const lower = d.toLowerCase();
  return clip.countryNames.some((n) => n.length > 3 && lower.includes(n));
}
