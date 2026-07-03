import { describe, it, expect } from "vitest";
import type { Polygon } from "geojson";
import { inClip, airportInClip, destMatchesCountry, type AoiClip } from "@/src/core/aoiClip";
import { bufferBbox } from "@/src/core/bbox";
import { coverageTiles, scopeTooBig, MAX_TILES } from "@/src/core/tiles";

// A 10°×10° square standing in for a country, centered near India.
const square: Polygon = {
  type: "Polygon",
  coordinates: [[[70, 15], [80, 15], [80, 25], [70, 25], [70, 15]]],
};

const clip: AoiClip = {
  bb: bufferBbox({ west: 70, south: 15, east: 80, north: 25 }, 0, 0.6),
  shapes: [{ id: "x", kind: "country", label: "India", ref: "India", geometry: square }],
  margin: 0.6,
  countryIso2: new Set(["IN"]),
  countryNames: ["india"],
};

describe("spatial clip", () => {
  it("keeps points inside the shape, drops far ones", () => {
    expect(inClip(75, 20, clip)).toBe(true); // dead center
    expect(inClip(80.4, 20, clip)).toBe(true); // just outside, within 0.6° halo
    expect(inClip(90, 20, clip)).toBe(false); // clearly outside
    expect(inClip(0, 0, clip)).toBe(false); // other hemisphere
  });
});

describe("route (airport) match", () => {
  it("keeps a flight whose origin/dest airport is in the shape, no halo", () => {
    expect(airportInClip(75, 20, clip)).toBe(true);
    expect(airportInClip(80.4, 20, clip)).toBe(false); // halo does NOT apply to airports
    expect(airportInClip(2.5, 49, clip)).toBe(false); // Paris — unrelated
  });
});

describe("coverage tiling", () => {
  it("uses ONE tile for a small state and covers within radius", () => {
    const t = coverageTiles({ west: -122.5, south: 37.2, east: -121.7, north: 38.0 });
    expect(t).not.toBeNull();
    expect(t!.length).toBe(1);
    expect(t![0].dist).toBe(250);
  });
  it("tiles a mid country into a few cells, all inside the bbox", () => {
    const uk = { west: -8, south: 50, east: 2, north: 59 };
    const t = coverageTiles(uk);
    expect(t).not.toBeNull();
    expect(t!.length).toBeGreaterThan(1);
    expect(t!.length).toBeLessThanOrEqual(MAX_TILES);
    for (const c of t!) {
      expect(c.lon).toBeGreaterThanOrEqual(uk.west);
      expect(c.lon).toBeLessThanOrEqual(uk.east);
      expect(c.lat).toBeGreaterThanOrEqual(uk.south);
      expect(c.lat).toBeLessThanOrEqual(uk.north);
    }
  });
  it("refuses a continent-sized scope as too big", () => {
    expect(coverageTiles({ west: -170, south: 10, east: -50, north: 72 })).toBeNull(); // North America
    expect(scopeTooBig({ west: 68, south: 6, east: 98, north: 36 })).toBe(true); // India
    expect(scopeTooBig({ west: -8, south: 50, east: 2, north: 59 })).toBe(false); // UK
  });
});

describe("ship destination match", () => {
  it("matches a LOCODE prefix or a country-name substring", () => {
    expect(destMatchesCountry("INBOM", clip)).toBe(true); // Mumbai LOCODE
    expect(destMatchesCountry("IN MAA", clip)).toBe(true); // spaced LOCODE
    expect(destMatchesCountry("MUMBAI, INDIA", clip)).toBe(true); // name substring
    expect(destMatchesCountry("USNYC", clip)).toBe(false); // New York
    expect(destMatchesCountry("SINGAPORE", clip)).toBe(false); // bare port, no table
    expect(destMatchesCountry("", clip)).toBe(false);
  });
});
