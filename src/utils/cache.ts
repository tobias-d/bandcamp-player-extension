interface TTLCacheEntry<V> {
  value: V;
  ts: number;
}

export class TTLCache<K, V> {
  private readonly store = new Map<K, TTLCacheEntry<V>>();

  public constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = Number.POSITIVE_INFINITY
  ) {}

  public get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.ts > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public set(key: K, value: V): void {
    this.store.set(key, { value, ts: Date.now() });
    if (this.store.size <= this.maxEntries) {
      return;
    }

    const oldest = this.store.keys().next().value as K | undefined;
    if (typeof oldest !== 'undefined') {
      this.store.delete(oldest);
    }
  }

  public has(key: K): boolean {
    return typeof this.get(key) !== 'undefined';
  }

  public delete(key: K): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }

  public entries(): Array<[K, { value: V; ts: number }]> {
    return Array.from(this.store.entries());
  }
}

export class DeduplicatedCache<K, V> {
  private readonly cache: TTLCache<K, V>;
  private readonly inFlight = new Map<K, Promise<V>>();

  public constructor(ttlMs: number, maxEntries: number = Number.POSITIVE_INFINITY) {
    this.cache = new TTLCache<K, V>(ttlMs, maxEntries);
  }

  public async get(key: K, factory: () => Promise<V>): Promise<V> {
    const cached = this.cache.get(key);
    if (typeof cached !== 'undefined') {
      return cached;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const pending = factory()
      .then((result) => {
        this.cache.set(key, result);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, pending);
    return pending;
  }

  public invalidate(key: K): void {
    this.inFlight.delete(key);
    this.cache.delete(key);
  }

  public clear(): void {
    this.inFlight.clear();
    this.cache.clear();
  }
}
