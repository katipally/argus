import { describe, it, expect } from "vitest";
import { argusFeature, clampSeverity, severityColor, SEVERITY_RAMP } from "@/src/core/feature";
import { presentationBand } from "@/src/core/aggregate";

describe("severity", () => {
  it("clamps to 0–4 integers and rejects junk", () => {
    expect(clampSeverity(-3)).toBe(0);
    expect(clampSeverity(99)).toBe(4);
    expect(clampSeverity(2.6)).toBe(3);
    expect(clampSeverity(NaN)).toBe(0);
  });
  it("maps every level to a distinct ramp color", () => {
    expect(new Set(SEVERITY_RAMP).size).toBe(5);
    expect(severityColor(4)).toBe(SEVERITY_RAMP[4]);
    expect(severityColor(-1)).toBe(SEVERITY_RAMP[0]);
  });
});

describe("argusFeature ingest guard", () => {
  it("builds a valid point feature", () => {
    const f = argusFeature(139.7, 35.7, { id: "x", layerId: "l", title: "t", severity: 2 });
    expect(f?.geometry.coordinates).toEqual([139.7, 35.7]);
    expect(f?.properties.severity).toBe(2);
  });
  it("drops out-of-range, NaN, and null-island coordinates", () => {
    const p = { id: "x", layerId: "l", title: "t", severity: 0 };
    expect(argusFeature(200, 10, p)).toBeNull();
    expect(argusFeature(10, 95, p)).toBeNull();
    expect(argusFeature(NaN, 10, p)).toBeNull();
    expect(argusFeature(0, 0, p)).toBeNull();
  });
});

describe("presentationBand", () => {
  it("selects heat → cluster → symbol across zoom", () => {
    expect(presentationBand(2, 6, 8)).toBe("heat");
    expect(presentationBand(7, 6, 8)).toBe("cluster");
    expect(presentationBand(12, 6, 8)).toBe("symbol");
    // boundaries
    expect(presentationBand(6, 6, 8)).toBe("cluster");
    expect(presentationBand(8, 6, 8)).toBe("cluster");
    expect(presentationBand(8.1, 6, 8)).toBe("symbol");
  });
});
