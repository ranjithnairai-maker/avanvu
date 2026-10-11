/**
 * Downloaded sessions on the device (SPEC §6.6): the app's Documents directory (never cache), default iOS data
 * protection (complete until first user authentication, so playback works while locked), excluded from backup,
 * verified by SHA-256 and byte length. A small JSON index records what is verified and what has been reported.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { excludeFromBackup } from '../../../modules/avanvu-backup';
import { api, withRetry } from '@/lib/api';
import type { SessionDto } from '@/lib/api/queries';
import { matchesExpected, planOfflineSync, type LocalFile, type RemoteSession } from '@/lib/offline/sync';

const root = () => new Directory(Paths.document, 'avanvu-sessions');
const indexFile = () => new File(root(), 'index.json');
export const sessionFile = (id: string) => new File(root(), `${id}.m4a`);

function ensureRoot(): void {
  const dir = root();
  if (!dir.exists) {
    dir.create({ intermediates: true });
    excludeFromBackup(dir.uri);
  }
}

export function readIndex(): LocalFile[] {
  try {
    const f = indexFile();
    return f.exists ? (JSON.parse(f.textSync()) as LocalFile[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(files: LocalFile[]): void {
  ensureRoot();
  const f = indexFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(files));
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function hashFile(file: File): Promise<{ sha256: string; bytes: number }> {
  const buf = await file.arrayBuffer();
  return {
    sha256: hex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, buf)),
    bytes: buf.byteLength,
  };
}

/** Download through a short-lived signed URL, verify, and record. A corrupt file is deleted. */
export async function downloadSession(s: Pick<SessionDto, 'id' | 'sha256' | 'bytes'>): Promise<boolean> {
  ensureRoot();
  const target = sessionFile(s.id);
  if (target.exists) target.delete();
  const { url } = await withRetry(() => api.post<{ url: string }>(`/v1/sessions/${s.id}/download-url`));
  const downloaded = await File.downloadFileAsync(url, target);
  excludeFromBackup(downloaded.uri);
  const actual = await hashFile(downloaded);
  if (!matchesExpected(actual, { sha256: s.sha256 ?? null, bytes: s.bytes ?? null })) {
    downloaded.delete();
    return false;
  }
  const index = readIndex().filter((f) => f.id !== s.id);
  index.push({ id: s.id, sha256: actual.sha256, bytes: actual.bytes, verified: true, reported: false });
  writeIndex(index);
  return true;
}

export function removeSession(id: string): void {
  const f = sessionFile(id);
  if (f.exists) f.delete();
  writeIndex(readIndex().filter((x) => x.id !== id));
}

export function removeAllSessions(): void {
  const dir = root();
  if (dir.exists) dir.delete();
}

const downloading = new Set<string>();
export const isDownloading = () => downloading;

/**
 * Runs on every foreground, on opening a notification and opportunistically in a background task. Safe to run
 * twice at once: a second call finds the downloads already in flight.
 */
export async function syncOfflineContent(): Promise<{ downloaded: number; failed: number }> {
  const { sessions } = await api.get<{ sessions: SessionDto[] }>('/v1/sessions', { query: { limit: 50 } });
  const remote: RemoteSession[] = sessions.map((s) => ({
    id: s.id,
    context: s.context,
    state: s.state,
    sha256: s.sha256 ?? null,
    bytes: s.bytes ?? null,
    readyAt: s.ready_at,
    forUpcomingSpecial: s.context !== 'training',
  }));
  // List responses omit the hash; fetch it for the sessions the plan wants.
  const plan0 = planOfflineSync(remote, readIndex());
  const need = new Set([...plan0.download, ...plan0.report]);
  for (const r of remote) {
    if (r.state === 'ready' && need.has(r.id) && !r.sha256) {
      const full = await api.get<SessionDto>(`/v1/sessions/${r.id}`);
      r.sha256 = full.sha256 ?? null;
      r.bytes = full.bytes ?? null;
    }
  }
  const plan = planOfflineSync(remote, readIndex());
  for (const id of plan.remove) removeSession(id);
  for (const id of plan.discard) removeSession(id);

  let downloaded = 0;
  let failed = 0;
  for (const id of plan.download) {
    if (downloading.has(id)) continue;
    const r = remote.find((x) => x.id === id) as RemoteSession;
    downloading.add(id);
    try {
      if (await downloadSession({ id, sha256: r.sha256, bytes: r.bytes })) downloaded++;
      else failed++;
    } catch {
      failed++;
    } finally {
      downloading.delete(id);
    }
  }
  // Tell the server which sessions are verified on this device (drives the T-48 h and T-24 h nudges).
  const index = readIndex();
  for (const f of index.filter((x) => x.verified && !x.reported)) {
    try {
      await api.post(`/v1/sessions/${f.id}/download-verified`, { sha256: f.sha256, bytes: f.bytes });
      f.reported = true;
    } catch {
      /* retried on the next sync */
    }
  }
  writeIndex(index);
  return { downloaded, failed };
}
