export type SourceHealth = "live" | "cached" | "down";

export interface BreakerOpts {
  name: string;
  /** Failures before the breaker trips open. */
  maxFailures?: number;
  /** How long to stay open (serving stale) before trying again. */
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Per-source circuit breaker with stale-serving. When a feed keeps failing, the
 * breaker opens and serves the last good value so ONE dead source never stalls
 * the globe. After the cooldown it closes and retries.
 */
export class CircuitBreaker<T> {
  readonly name: string;
  private failures = 0;
  private openUntil = 0;
  private last: T | null = null;
  private maxFailures: number;
  private cooldownMs: number;
  private now: () => number;

  constructor(o: BreakerOpts) {
    this.name = o.name;
    this.maxFailures = o.maxFailures ?? 3;
    this.cooldownMs = o.cooldownMs ?? 30_000;
    this.now = o.now ?? Date.now;
  }

  get isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  /**
   * Run `fn` unless the breaker is open. Never throws: on failure (or while
   * open) returns the last good value, or `fallback` if we never had one.
   */
  async execute(
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<{ value: T; health: SourceHealth }> {
    if (this.isOpen) {
      return this.last != null
        ? { value: this.last, health: "cached" }
        : { value: fallback, health: "down" };
    }
    try {
      const value = await fn();
      this.failures = 0;
      this.last = value;
      return { value, health: "live" };
    } catch {
      this.failures++;
      if (this.failures >= this.maxFailures) {
        this.openUntil = this.now() + this.cooldownMs;
      }
      return this.last != null
        ? { value: this.last, health: "cached" }
        : { value: fallback, health: "down" };
    }
  }
}
