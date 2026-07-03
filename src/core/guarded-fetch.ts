import type { BboxCache } from "./cache";
import type { CircuitBreaker, SourceHealth } from "./circuit-breaker";

export type FetchStatus = SourceHealth; // "live" | "cached" | "down"

/**
 * Wraps a per-layer cache + circuit breaker and adds SINGLE-FLIGHT dedup:
 * concurrent calls for the same key share one in-flight request. Without this,
 * a burst of map-idle events (flyTo, tile churn) fires N identical fetches
 * before the first resolves to populate the cache — a thundering herd that
 * hammers the upstream API. This is the anti-hammer guarantee the plan requires.
 */
export function createGuardedFetch<T>(cache: BboxCache<T>, breaker: CircuitBreaker<T>) {
  const inflight = new Map<string, Promise<{ value: T; status: FetchStatus }>>();

  return function guarded(
    key: string,
    fetchFn: () => Promise<T>,
    fallback: T,
  ): Promise<{ value: T; status: FetchStatus }> {
    const hit = cache.get(key);
    if (hit) return Promise.resolve({ value: hit, status: "cached" });

    const existing = inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      const { value, health } = await breaker.execute(fetchFn, fallback);
      if (health === "live") cache.set(key, value);
      return { value, status: health };
    })().finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  };
}
