import { describe, it, expect } from "vitest";
import { geomCenter } from "@/src/layers/interactions";

describe("geomCenter", () => {
  it("returns a Point's own coordinates", () => {
    expect(geomCenter({ type: "Point", coordinates: [139.7, 35.7] })).toEqual([139.7, 35.7]);
  });
  it("returns the bbox center of a Polygon", () => {
    const g: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [10, 0], [10, 20], [0, 20], [0, 0]]],
    };
    expect(geomCenter(g)).toEqual([5, 10]);
  });
  it("handles LineString and MultiPolygon", () => {
    expect(geomCenter({ type: "LineString", coordinates: [[-10, -10], [10, 10]] })).toEqual([0, 0]);
    const mp: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [4, 0], [4, 4], [0, 0]]], [[[6, 6], [8, 6], [8, 8], [6, 6]]]],
    };
    expect(geomCenter(mp)).toEqual([4, 4]);
  });
});

