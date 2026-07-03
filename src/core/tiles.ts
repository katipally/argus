import { type Bbox, bboxWraps } from "./bbox";

// ADS-B feeds only answer point+radius queries capped at 250nm, so covering a
// whole country means TILING its bbox into a grid of overlapping radius queries.
// Big scopes (continents, huge countries) need too many tiles to fetch/render
// digestibly — those return null so the caller can say "pick something smaller".
const NM_PER_DEG = 60;
const TILE_DIST_NM = 250; // per-query radius (upstream hard cap)
// spacing ≤ 250·√2 guarantees the radius-250 circles fully cover the grid cells.
const SPACING_NM = 350;

export const MAX_TILES = 8; // ~mid-country ceiling; beyond this = "too big"

export interface Tile {
  lat: number;
  lon: number;
  dist: number;
}

/**
 * Grid of point+radius tiles covering `b`, or null when it needs more than
 * `max` tiles (too big to fetch digestibly). Longitude spacing is corrected for
 * latitude so high-latitude scopes don't over-tile.
 */
export function coverageTiles(b: Bbox, max = MAX_TILES): Tile[] | null {
  const latSpan = Math.max(0, b.north - b.south);
  const lonSpan = bboxWraps(b) ? b.east + 360 - b.west : b.east - b.west;
  const midLat = (b.north + b.south) / 2;
  const cosLat = Math.max(0.15, Math.cos((midLat * Math.PI) / 180));
  const hNm = latSpan * NM_PER_DEG;
  const wNm = lonSpan * NM_PER_DEG * cosLat;
  const rows = Math.max(1, Math.ceil(hNm / SPACING_NM));
  const cols = Math.max(1, Math.ceil(wNm / SPACING_NM));
  if (rows * cols > max) return null;
  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = b.south + ((r + 0.5) * latSpan) / rows;
    for (let c = 0; c < cols; c++) {
      let lon = b.west + ((c + 0.5) * lonSpan) / cols;
      if (lon > 180) lon -= 360;
      tiles.push({ lat, lon, dist: TILE_DIST_NM });
    }
  }
  return tiles;
}

/** True when a bbox is too large to fetch as digestible live movement data. */
export function scopeTooBig(b: Bbox, max = MAX_TILES): boolean {
  return coverageTiles(b, max) === null;
}
