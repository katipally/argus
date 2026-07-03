/**
 * Tiny TTL cache keyed by bbox. `now` is injectable so tests can advance time
 * without waiting. In-memory only, entry-capped so a long panning session
 * can't grow it unbounded (oldest inserted evicts first — Map is ordered).
 */
export class BboxCache<T> {
  private store = new Map<string, { value: T; expires: number }>();
  private static readonly MAX_ENTRIES = 64;

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= BboxCache.MAX_ENTRIES && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: this.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
