import { describe, it, expect } from "vitest";
import { geometryBbox, bboxWraps, bufferBbox, pointInGeometry, distToGeometryDeg } from "@/src/core/bbox";
import type { Polygon } from "geojson";

const poly = (ring: [number, number][]): Polygon => ({ type: "Polygon", coordinates: [ring] });

describe("geometryBbox — antimeridian", () => {
  it("keeps a normal shape's bbox tight", () => {
    const b = geometryBbox(poly([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]))!;
    expect(b).toEqual({ west: 0, south: 0, east: 10, north: 10 });
    expect(bboxWraps(b)).toBe(false);
  });

  it("detects a shape crossing +180/-180 and returns a wrap bbox (west>east)", () => {
    // Fiji-like: sits around 177E .. -178E
    const b = geometryBbox(poly([[177, -18], [179, -18], [-178, -16], [-179, -19], [177, -18]]))!;
    expect(bboxWraps(b)).toBe(true); // west 177, east -178
    expect(b.west).toBeGreaterThan(b.east);
    // the span the short way is small, not ~355°
    expect(b.east + 360 - b.west).toBeLessThan(20);
  });

  it("bufferBbox preserves the wrap and stays in [-180,180]", () => {
    const b = bufferBbox({ west: 177, south: -20, east: -178, north: -15 }, 0.1);
    expect(b.west).toBeLessThanOrEqual(180);
    expect(b.east).toBeGreaterThanOrEqual(-180);
    expect(bboxWraps(b)).toBe(true);
  });
});

import { nightPolygon } from "@/src/map/terminator";

describe("terminator", () => {
  const poleOf = (ms: number) => nightPolygon(ms).coordinates[0][0][1];
  it("closes toward the south pole near northern summer solstice", () => {
    // 2024-06-21 — declination > 0 → southern hemisphere is in polar night
    expect(poleOf(Date.UTC(2024, 5, 21, 12))).toBe(-90);
  });
  it("closes toward the north pole near northern winter solstice", () => {
    expect(poleOf(Date.UTC(2024, 11, 21, 12))).toBe(90);
  });
  it("produces a closed ring", () => {
    const r = nightPolygon(Date.UTC(2024, 2, 15, 0)).coordinates[0];
    expect(r[0]).toEqual(r[r.length - 1]);
  });
});

describe("point-in-polygon AOI filter", () => {
  // an "L"-shaped country so the rectangular bbox includes area OUTSIDE the shape
  const L: Polygon = {
    type: "Polygon",
    coordinates: [[[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4], [0, 0]]],
  };
  it("keeps a point inside the shape", () => {
    expect(pointInGeometry(1, 1, L)).toBe(true);
  });
  it("rejects a point in the bbox but OUTSIDE the shape (the whole point of this)", () => {
    // (3,3) is within the 0..4 bbox but sits in the L's missing quadrant
    expect(pointInGeometry(3, 3, L)).toBe(false);
    expect(distToGeometryDeg(3, 3, L)).toBeGreaterThan(0.9); // ~1 deg from the notch edges
  });
  it("reports zero distance for an interior point and grows with distance outside", () => {
    expect(distToGeometryDeg(1, 1, L)).toBe(0);
    expect(distToGeometryDeg(6, 1, L)).toBeCloseTo(2, 5); // 2 deg east of the x=4 edge
  });
});
