// Keyless basemap styles (OpenFreeMap, no token). Two real modes instead of a
// dim-overlay hack: "dark" is a purpose-built dark-matter style (default —
// data colors glow, Gotham look), "light" is the clean positron day style.
// Satellite rides ON the dark style (Esri raster inserted below its labels).
export const STYLE_URLS = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
} as const;

export const BASEMAP_STYLE_URL = STYLE_URLS.dark;

// Initial camera: whole globe, gently tilted.
export const INITIAL_VIEW = {
  longitude: 10,
  latitude: 25,
  zoom: 1.6,
  pitch: 0,
  bearing: 0,
} as const;
