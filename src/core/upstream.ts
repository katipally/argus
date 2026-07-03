// Shared server-side fetch for every /api proxy route. Three jobs:
//  1. Send a descriptive User-Agent (Nominatim/NWS/Wikimedia REQUIRE one; GDELT
//     throttles requests without it) with a contact address.
//  2. Time out slow upstreams so a route never hangs a client fetch.
//  3. Per-host politeness: enforce a minimum gap between calls to the same host
//     (Nominatim/adsb.fi = 1 req/s, Overpass fair-use) so Argus never hammers.
//
// Local-only, single Next process → a module-level Map of last-call timestamps
// is enough. ponytail: in-process throttle; needs Redis only if multi-instance.

export const ARGUS_UA =
  "Argus/3.0 (personal OSINT dashboard; katipally.yashwanth.reddy@gmail.com)";

const lastCall = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UpstreamOpts {
  /** Minimum ms between calls to this host (default 0 = no throttle). */
  minGapMs?: number;
  /** Abort after this many ms (default 12s). */
  timeoutMs?: number;
  /** Extra request headers (merged over the UA). */
  headers?: Record<string, string>;
  /** Passed through to fetch (default "no-store" — routes set their own edge cache). */
  cache?: RequestCache;
}

/**
 * Fetch an upstream URL politely. Throws on network error/timeout (routes catch
 * and return a 502) — it never returns a non-ok Response silently.
 */
export async function upstreamFetch(url: string, opts: UpstreamOpts = {}): Promise<Response> {
  const { minGapMs = 0, timeoutMs = 12_000, headers, cache = "no-store" } = opts;
  const host = new URL(url).host;

  if (minGapMs > 0) {
    const since = Date.now() - (lastCall.get(host) ?? 0);
    if (since < minGapMs) await sleep(minGapMs - since);
    lastCall.set(host, Date.now());
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache,
      signal: ctrl.signal,
      headers: { "User-Agent": ARGUS_UA, Accept: "application/json", ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: fetch + parse JSON, throwing on non-ok. */
export async function upstreamJson<T>(url: string, opts?: UpstreamOpts): Promise<T> {
  const r = await upstreamFetch(url, opts);
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return (await r.json()) as T;
}
