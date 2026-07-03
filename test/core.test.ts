import { describe, it, expect } from "vitest";
import { bboxKey, quantizeBbox } from "@/src/core/bbox";
import { BboxCache } from "@/src/core/cache";
import { CircuitBreaker } from "@/src/core/circuit-breaker";
import { createGuardedFetch } from "@/src/core/guarded-fetch";
import { LayerManager, type MapLike } from "@/src/layers/LayerManager";
import type { LayerModule } from "@/src/layers/types";
import { useArgusStore } from "@/src/store/useArgusStore";

describe("bbox", () => {
  it("quantizes near-identical viewports to the same cache key", () => {
    const a = bboxKey({ west: 0.1, south: 0.2, east: 9.9, north: 10.1 });
    const b = bboxKey({ west: -0.3, south: -0.4, east: 10.2, north: 9.7 });
    expect(a).toBe(b); // both snap to 0,0,10,10 → cache hit on small pans
    expect(quantizeBbox({ west: 0.1, south: 0.2, east: 9.9, north: 10.1 })).toEqual({
      west: 0,
      south: 0,
      east: 10,
      north: 10,
    });
  });

  it("gives different keys to genuinely different areas", () => {
    expect(bboxKey({ west: 0, south: 0, east: 10, north: 10 })).not.toBe(
      bboxKey({ west: 100, south: 20, east: 110, north: 30 }),
    );
  });
});

describe("BboxCache", () => {
  it("returns within TTL, null after expiry", () => {
    let t = 1000;
    const cache = new BboxCache<number>(500, () => t);
    cache.set("k", 42);
    expect(cache.get("k")).toBe(42);
    t = 1600; // past 1000+500
    expect(cache.get("k")).toBeNull();
  });
});

describe("CircuitBreaker", () => {
  it("opens after maxFailures, serves cache during cooldown, resets after it", async () => {
    let t = 0;
    const b = new CircuitBreaker<number>({ name: "x", maxFailures: 2, cooldownMs: 1000, now: () => t });

    // a good call caches the value
    expect(await b.execute(async () => 1, -1)).toEqual({ value: 1, health: "live" });

    // failure #1 — not open yet, serves cached
    expect(await b.execute(async () => { throw new Error("boom"); }, -1)).toEqual({
      value: 1,
      health: "cached",
    });
    // failure #2 — trips open
    await b.execute(async () => { throw new Error("boom"); }, -1);
    expect(b.isOpen).toBe(true);

    // while open, fn is NOT called; cached value served
    let called = false;
    const r = await b.execute(async () => { called = true; return 99; }, -1);
    expect(called).toBe(false);
    expect(r).toEqual({ value: 1, health: "cached" });

    // after cooldown, closes and retries live
    t = 1001;
    expect(b.isOpen).toBe(false);
    expect(await b.execute(async () => 2, -1)).toEqual({ value: 2, health: "live" });
  });

  it("reports 'down' when it has never had a good value", async () => {
    const b = new CircuitBreaker<number>({ name: "y", maxFailures: 1 });
    expect(await b.execute(async () => { throw new Error(); }, -1)).toEqual({
      value: -1,
      health: "down",
    });
  });
});

describe("guardedFetch (single-flight + cache)", () => {
  it("collapses concurrent identical requests into ONE upstream fetch", async () => {
    const now = () => 0;
    const cache = new BboxCache<number>(1000, now);
    const breaker = new CircuitBreaker<number>({ name: "g", now });
    const guarded = createGuardedFetch(cache, breaker);

    let calls = 0;
    const fetchFn = () =>
      new Promise<number>((resolve) => {
        calls++;
        setTimeout(() => resolve(7), 5);
      });

    // three concurrent callers for the same key
    const results = await Promise.all([
      guarded("k", fetchFn, -1),
      guarded("k", fetchFn, -1),
      guarded("k", fetchFn, -1),
    ]);
    expect(calls).toBe(1); // the herd collapsed to one request
    expect(results.map((r) => r.value)).toEqual([7, 7, 7]);
    expect(results[0].status).toBe("live");

    // subsequent call is a cache hit — still one upstream fetch total
    const again = await guarded("k", fetchFn, -1);
    expect(again.status).toBe("cached");
    expect(calls).toBe(1);
  });
});

describe("LayerManager.refresh (LOD + toggle discipline)", () => {
  function makeMap(zoom: number): MapLike & { _zoom: number } {
    return {
      _zoom: zoom,
      getZoom() { return this._zoom; },
      getBounds() {
        return { getWest: () => -10, getSouth: () => -10, getEast: () => 10, getNorth: () => 10 };
      },
      on() {},
      off() {},
      flyTo() {},
    };
  }

  function makeLayer(id: string, minZoom: number, viewportFallback = false) {
    const layer: LayerModule & { updates: boolean[]; visible: boolean } = {
      id,
      label: id,
      color: "#fff",
      group: "earth",
      minZoom,
      maxFeatures: 100,
      defaultEnabled: true,
      viewportFallback,
      updates: [],
      visible: true,
      init() {},
      async update(_vp, load) { layer.updates.push(load); },
      setVisible(v) { layer.visible = v; },
      destroy() {},
    };
    return layer;
  }

  it("streams whenever active (AOI+enabled), zoom only gates visibility", async () => {
    useArgusStore.getState().setAoi(null);
    const mgr = new LayerManager();
    const layer = makeLayer("mock-a", 5);
    mgr.register(layer);
    const map = makeMap(2);
    await mgr.start(map); // no AOI → inactive
    expect(layer.updates.at(-1)).toBe(false);
    expect(layer.visible).toBe(false);

    // AOI set, still zoomed out below minZoom → ACTIVE (streaming) but NOT visible
    useArgusStore.getState().setAoi({
      kind: "country",
      label: "X",
      bbox: { west: -10, south: -10, east: 10, north: 10 },
    }); // auto-refreshes via subscription (zoom still 2)
    expect(layer.updates.at(-1)).toBe(true);
    expect(layer.visible).toBe(false);

    // zoom past minZoom → now visible (stream never restarted)
    map._zoom = 8;
    mgr.refresh();
    expect(layer.updates.at(-1)).toBe(true);
    expect(layer.visible).toBe(true);

    // disable → inactive + hidden
    mgr.toggleLayer("mock-a", false);
    expect(layer.updates.at(-1)).toBe(false);
    expect(layer.visible).toBe(false);

    useArgusStore.getState().setAoi(null); // reset shared store
  });

  it("street layers (viewportFallback) load from the viewport when zoomed in with no AOI", async () => {
    useArgusStore.getState().setAoi(null);
    const mgr = new LayerManager();
    const street = makeLayer("mock-street", 7, true);
    const sky = makeLayer("mock-sky", 0, false); // no fallback → stays off without AOI
    mgr.register(street);
    mgr.register(sky);
    const map = makeMap(3); // zoomed out, below street minZoom
    await mgr.start(map);
    expect(street.updates.at(-1)).toBe(false); // no AOI, not zoomed in → off
    expect(sky.updates.at(-1)).toBe(false);

    map._zoom = 12; // zoom into a city
    mgr.refresh();
    expect(street.updates.at(-1)).toBe(true); // street layer loads for the viewport
    expect(street.visible).toBe(true);
    expect(sky.updates.at(-1)).toBe(false); // global layer still needs an AOI

    useArgusStore.getState().setAoi(null);
  });
});
