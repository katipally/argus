import { describe, it, expect } from "vitest";
import type { Bbox } from "@/src/core/bbox";
import { bboxIntersects } from "@/src/core/bbox";
import { selectProviders } from "@/src/layers/feeds/camera-providers";
import { curatedWebcams } from "@/src/layers/feeds/webcam-catalog";

// The region selector is what makes "worldwide catalog, load only the selected
// region" work — if it over-selects we fetch the whole world, if it under-selects
// the layer looks empty. This is the piece most likely to silently break.
describe("feed region selection", () => {
  const bayArea: Bbox = { west: -122.6, south: 37.2, east: -121.8, north: 38.0 };
  const boston: Bbox = { west: -71.2, south: 42.3, east: -71.0, north: 42.4 };

  it("bboxIntersects is symmetric and rejects disjoint boxes", () => {
    expect(bboxIntersects(bayArea, boston)).toBe(false);
    expect(bboxIntersects(bayArea, bayArea)).toBe(true);
  });

  it("cameras: Bay Area picks Caltrans D04 but not LA's D07", () => {
    const ids = selectProviders(bayArea).map((p) => p.id);
    expect(ids).toContain("caltrans-d4");
    expect(ids).not.toContain("caltrans-d7");
  });

  it("webcams: NYC AOI surfaces Times Square but not Shibuya, with an embed", () => {
    const nyc: Bbox = { west: -74.3, south: 40.4, east: -73.6, north: 41.0 };
    const cams = curatedWebcams(nyc);
    const ids = cams.map((c) => c.id);
    expect(ids).toContain("yt-timessquare");
    expect(ids).not.toContain("yt-shibuya");
    expect(cams[0].embedUrl).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\//);
  });
});
