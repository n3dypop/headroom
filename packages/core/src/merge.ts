// Merge snapshots from several collectors (Mac / Windows, etc.) into one.
// Intended for the server (Worker) on GET. Picks per provider by recency and collector priority.

import { RESET_TOLERANCE_MS, preferCollector, simultaneousMs, type CollectorSelection } from "./collector-selection.ts";
import { SCHEMA_VERSION, type ProviderId, type ProviderSnapshot, type Snapshot } from "./schema.ts";

const STATUS_PRIORITY: Record<ProviderSnapshot["status"], number> = {
  ok: 3,
  stale: 2,
  error: 1,
  unavailable: 0,
};

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function overlapsCycle(candidate: ProviderSnapshot, latest: ProviderSnapshot): boolean {
  const resetTimes = new Map(latest.windows.map((w) => [w.id, time(w.resets_at)]));
  return candidate.windows.every((w) => {
    const a = time(w.resets_at);
    const b = resetTimes.get(w.id);
    return b === undefined || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) <= RESET_TOLERANCE_MS;
  });
}

function pickProvider(entries: ProviderSnapshot[], options: CollectorSelection): ProviderSnapshot | undefined {
  const withData = entries
    .filter((p) => p.windows.length > 0 || typeof p.blocked === "boolean")
    .map((p) => ({ at: time(p.fetched_at), collector: p.collector, snapshot: p }))
    .filter((p) => Number.isFinite(p.at));
  const latest = preferCollector(withData, (p) => p);
  const within = simultaneousMs(options);
  const nearLatest = latest ? withData.filter((p) => latest.at - p.at <= within
    && overlapsCycle(p.snapshot, latest.snapshot)) : [];
  // Among those, a value its PC marked old (its next fetch failed, as a rate limit's) gives way to a current one; the PCs' priority
  // then picks among what is left: the current ones, or all of them when every one is marked old
  const current = nearLatest.filter((p) => p.snapshot.status !== "stale");
  const selected = preferCollector(current.length > 0 ? current : nearLatest, (p) => p, options.collectorPriority);
  if (selected) return selected.snapshot;
  // If none has values, pick by status severity (show error rather than unavailable)
  return [...entries].sort((a, b) => STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status])[0];
}

export function mergeSnapshots(snapshots: readonly Snapshot[], options: CollectorSelection = {}): Snapshot | null {
  const valid = snapshots.filter((s) => s.schema_version === SCHEMA_VERSION);
  if (valid.length === 0) return null;

  const ids = new Set<ProviderId>();
  for (const s of valid) for (const id of Object.keys(s.providers) as ProviderId[]) ids.add(id);

  const providers: Partial<Record<ProviderId, ProviderSnapshot>> = {};
  for (const id of ids) {
    const entries = valid.flatMap((s) => {
      const p = s.providers[id];
      // Even if an old collector doesn't set collector, fill it in from the snapshot's name
      return p ? [{ ...p, collector: p.collector ?? s.collector ?? null }] : [];
    });
    const chosen = pickProvider(entries, options);
    if (chosen) providers[id] = chosen;
  }

  const generated_at = valid
    .map((s) => s.generated_at)
    .reduce((a, b) => (time(b) > time(a) ? b : a));
  // Which PCs sent values (newest first). Lets displays tell e.g. "the Mac has stopped"
  const collectors = valid
    .filter((s): s is Snapshot & { collector: string } => typeof s.collector === "string")
    .map((s) => ({ id: s.collector, generated_at: s.generated_at, received_at: null }))
    .sort((a, b) => time(b.generated_at) - time(a.generated_at));
  return { schema_version: SCHEMA_VERSION, generated_at, providers, collectors };
}
