import { Injectable } from '@nestjs/common';

type Entry = { value: unknown; expiresAt: number };

/**
 * Small in-process TTL cache for shared, rarely-changing reads that every
 * user hits identically (subject list, section list, events aggregate,
 * timetables, admin student directory). Cached values are treated as
 * immutable — services must build new objects when deriving from them.
 *
 * Per process by design, same trade-off as the rate-limit store: fine for
 * the single-instance deployment; swap for Redis when scaling horizontally.
 */
@Injectable()
export class CacheService {
  private store = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= 1000) this.sweep();
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Get-or-load with in-flight de-dupe: a burst of concurrent requests for
   *  the same key (e.g. 200 dashboards mounting at 9 am) runs the loader
   *  exactly once and shares the pending promise. */
  async wrap<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const flight = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, flight);
    return flight;
  }

  /** Drop one key plus anything namespaced under it — invalidate('timetable')
   *  clears 'timetable:week:<id>' and 'timetable:faculty:<id>'. */
  invalidate(prefix: string): void {
    const scope = `${prefix}:`;
    for (const key of this.store.keys()) {
      if (key === prefix || key.startsWith(scope)) this.store.delete(key);
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }
}
