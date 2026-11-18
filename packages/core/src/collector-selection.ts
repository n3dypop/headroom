/** The server's collector_priority and the tolerance for "simultaneous". */
export interface CollectorSelection {
  collectorPriority?: readonly string[];
  simultaneousMinutes?: number;
}

export const RESET_TOLERANCE_MS = 5 * 60_000;

export function simultaneousMs(options: CollectorSelection): number {
  const minutes = options.simultaneousMinutes ?? 2;
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : 2) * 60_000;
}

export function preferCollector<T>(
  candidates: readonly T[],
  identity: (candidate: T) => { collector: string | null; at: number },
  priority: readonly string[] = [],
): T | undefined {
  const rank = (collector: string | null) => {
    const position = collector === null ? -1 : priority.indexOf(collector);
    return position < 0 ? priority.length : position;
  };
  let best: T | undefined;
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const a = identity(candidate);
    const b = identity(best);
    const byPriority = rank(a.collector) - rank(b.collector);
    if (byPriority < 0 || (byPriority === 0 && a.at > b.at)) best = candidate;
  }
  return best;
}
