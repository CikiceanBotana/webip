/**
 * The project's single concurrency primitive.
 *
 * Everything that does independent work in bulk -- fetching pages, running the
 * fast lane, driving browser workers -- goes through here rather than growing
 * its own ad-hoc Promise.all. One implementation, one place to get the
 * back-pressure right.
 */

/**
 * Maps `items` through `fn` with at most `limit` in flight.
 *
 * Results keep input order regardless of completion order. A rejected `fn`
 * rejects the whole call, so callers that want per-item tolerance should catch
 * inside `fn` and return an error value -- the lanes all do this, because one
 * broken page must never abort a 6,000-page sweep.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      // Guarded by the bounds check above; noUncheckedIndexedAccess needs the cast.
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/**
 * Like `mapPool`, but a thrown error becomes `null` for that item instead of
 * failing the batch. Use when partial results are better than none.
 */
export async function mapPoolSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onError?: (err: unknown, item: T, index: number) => void,
): Promise<Array<R | null>> {
  return mapPool(items, limit, async (item, index) => {
    try {
      return await fn(item, index);
    } catch (err) {
      onError?.(err, item, index);
      return null;
    }
  });
}

/**
 * Splits work into fixed-size batches.
 *
 * The fast lane's process-based checks (java, lychee) amortise their startup
 * over a batch, so batch size is a real tuning knob: too small and you pay JVM
 * startup repeatedly, too large and one slow site stalls the whole batch and
 * memory balloons.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(items.slice(i, i + width));
  }
  return out;
}

/** Rejects after `ms`, so a hung tool cannot stall a worker forever. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
