import type { Bbox } from "@/src/core/bbox";

export interface Scope {
  id: string;
  label: string;
  bbox: Bbox;
}

const b = (west: number, south: number, east: number, north: number): Bbox => ({
  west,
  south,
  east,
  north,
});

// Approximate bounding boxes (kept within [-180,180], west<east to avoid
// antimeridian wrap issues in the fetch/render pipeline).
export const CONTINENTS: Scope[] = [
  { id: "africa", label: "Africa", bbox: b(-18, -35, 52, 38) },
  { id: "europe", label: "Europe", bbox: b(-25, 34, 45, 72) },
  { id: "asia", label: "Asia", bbox: b(26, -11, 180, 78) },
  { id: "north-america", label: "North America", bbox: b(-168, 7, -52, 72) },
  { id: "south-america", label: "South America", bbox: b(-82, -56, -34, 13) },
  { id: "oceania", label: "Oceania", bbox: b(110, -48, 180, 0) },
  { id: "antarctica", label: "Antarctica", bbox: b(-180, -90, 180, -60) },
];

export const OCEANS: Scope[] = [
  { id: "pacific", label: "Pacific (W/C)", bbox: b(120, -60, 180, 65) },
  { id: "atlantic", label: "Atlantic", bbox: b(-70, -60, 20, 65) },
  { id: "indian", label: "Indian", bbox: b(20, -60, 120, 30) },
  { id: "southern", label: "Southern", bbox: b(-180, -78, 180, -45) },
  { id: "arctic", label: "Arctic", bbox: b(-180, 66, 180, 90) },
];

export const REGIONS: Scope[] = [
  { id: "mediterranean", label: "Mediterranean", bbox: b(-6, 30, 37, 47) },
  { id: "middle-east", label: "Middle East", bbox: b(34, 12, 63, 42) },
  { id: "persian-gulf", label: "Persian Gulf", bbox: b(47, 23, 60, 31) },
  { id: "sea-asia", label: "Southeast Asia", bbox: b(92, -11, 141, 29) },
  { id: "east-asia", label: "East Asia", bbox: b(100, 20, 146, 54) },
  { id: "south-asia", label: "South Asia", bbox: b(60, 5, 97, 37) },
  { id: "scandinavia", label: "Scandinavia", bbox: b(4, 54, 32, 71) },
  { id: "balkans", label: "Balkans", bbox: b(13, 38, 30, 47) },
  { id: "caribbean", label: "Caribbean", bbox: b(-88, 9, -59, 27) },
  { id: "central-america", label: "Central America", bbox: b(-93, 7, -77, 19) },
  { id: "west-africa", label: "West Africa", bbox: b(-18, 4, 16, 28) },
  { id: "horn-africa", label: "Horn of Africa", bbox: b(32, -5, 52, 18) },
];
