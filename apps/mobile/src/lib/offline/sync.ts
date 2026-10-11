/**
 * Offline readiness (SPEC §6.6). `syncOfflineContent` runs on every foreground, on opening a notification
 * and opportunistically in a background task: it downloads any ready session for upcoming special items and
 * the most recent training session, verifies SHA-256 and byte length, reports the verification to the server,
 * and removes files for sessions that no longer exist. The planner is pure; the native file and network calls
 * are thin wrappers around it.
 */
export interface RemoteSession {
  id: string;
  context: 'training' | 'night_before' | 'primer';
  state: string;
  sha256: string | null;
  bytes: number | null;
  readyAt: string | null;
  /** True when the session belongs to an upcoming night-before or primer program item. */
  forUpcomingSpecial: boolean;
}

export interface LocalFile {
  id: string;
  sha256: string;
  bytes: number;
  /** Verified against the server's hash and length after download. */
  verified: boolean;
  /** Already reported to the server with POST /sessions/:id/download-verified. */
  reported: boolean;
}

export interface SyncPlan {
  download: string[];
  /** Local file exists but is corrupt or stale: delete it, show Online only, redownload when possible. */
  discard: string[];
  remove: string[];
  report: string[];
}

export function planOfflineSync(remote: readonly RemoteSession[], local: readonly LocalFile[]): SyncPlan {
  const ready = remote.filter((s) => s.state === 'ready' && s.sha256 && s.bytes);
  const wanted = new Set<string>();
  for (const s of ready) if (s.forUpcomingSpecial) wanted.add(s.id);
  const latestTraining = ready
    .filter((s) => s.context === 'training')
    .sort((a, b) => (b.readyAt ?? '').localeCompare(a.readyAt ?? ''))[0];
  if (latestTraining) wanted.add(latestTraining.id);

  const localById = new Map(local.map((f) => [f.id, f]));
  const remoteById = new Map(remote.map((s) => [s.id, s]));
  const plan: SyncPlan = { download: [], discard: [], remove: [], report: [] };

  for (const id of wanted) {
    const r = remoteById.get(id) as RemoteSession;
    const f = localById.get(id);
    if (!f) plan.download.push(id);
    else if (f.sha256 !== r.sha256 || f.bytes !== r.bytes || !f.verified) {
      plan.discard.push(id);
      plan.download.push(id);
    } else if (!f.reported) plan.report.push(id);
  }
  for (const f of local) {
    const r = remoteById.get(f.id);
    if (!r || r.state === 'failed' || r.state === 'canceled') plan.remove.push(f.id); // deleted on the server
  }
  return plan;
}

export type OfflineBadge = 'ready_offline' | 'downloading' | 'online_only' | 'preparing';

export function offlineBadge(
  session: Pick<RemoteSession, 'id' | 'state' | 'sha256' | 'bytes'>,
  local: LocalFile | undefined,
  downloading: ReadonlySet<string>,
): OfflineBadge {
  if (session.state !== 'ready') return 'preparing';
  if (downloading.has(session.id)) return 'downloading';
  if (local && local.verified && local.sha256 === session.sha256 && local.bytes === session.bytes)
    return 'ready_offline';
  return 'online_only';
}

/** Hex SHA-256 comparison and length check for a downloaded file. */
export function matchesExpected(
  actual: { sha256: string; bytes: number },
  expected: { sha256: string | null; bytes: number | null },
): boolean {
  return (
    !!expected.sha256 &&
    !!expected.bytes &&
    actual.sha256.toLowerCase() === expected.sha256.toLowerCase() &&
    actual.bytes === expected.bytes
  );
}

/** Offline storage the athlete can see and clear (SPEC §6.6). */
export function storageSummary(local: readonly LocalFile[]): { files: number; bytes: number } {
  return { files: local.length, bytes: local.reduce((n, f) => n + f.bytes, 0) };
}

/** Home shows a prominent "Save for offline" when the event is near and a special session is not on the device. */
export function needsOfflineAttention(
  eventStartsAt: Date,
  now: Date,
  specialSessions: readonly { id: string; state: string }[],
  local: readonly LocalFile[],
): boolean {
  const hours = (eventStartsAt.getTime() - now.getTime()) / 3_600_000;
  if (hours <= 0 || hours > 72) return false;
  return specialSessions.some((s) => s.state === 'ready' && !local.find((f) => f.id === s.id && f.verified));
}
