import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { SessionDto } from '@/lib/api/queries';
import { readIndex, sessionFile } from '@/lib/native/sessionFiles';
import { PlayRecorder, type PlayEvent } from './plays';

/**
 * Playback for one session (SPEC §6.5): the verified local file when there is one (works offline and locked),
 * otherwise a short-lived signed URL. Background playback and lock-screen controls come from expo-audio with
 * `doNotMix`. Play marks are recorded locally and synced in batches; there are no haptics during playback.
 */
export function useSessionAudio(session: SessionDto | null) {
  const [uri, setUri] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef(new PlayRecorder(() => Crypto.randomUUID()));
  const player = useAudioPlayer(uri ?? undefined);
  const status = useAudioPlayerStatus(player);
  const flushing = useRef(false);

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });
  }, []);

  useEffect(() => {
    if (!session || session.status !== 'ready') return;
    let alive = true;
    (async () => {
      const local = readIndex().find((f) => f.id === session.id && f.verified);
      const file = sessionFile(session.id);
      if (local && file.exists) {
        if (alive) {
          setUri(file.uri);
          setOnline(false);
        }
        return;
      }
      try {
        const { url } = await api.post<{ url: string }>(`/v1/sessions/${session.id}/download-url`);
        if (alive) {
          setUri(url);
          setOnline(true);
        }
      } catch {
        if (alive) setError("We couldn't load this session. Connect to the internet, or download it first.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [session]);

  const flush = useCallback(async () => {
    if (!session || flushing.current) return;
    const batch = recorder.current.batch();
    if (batch.length === 0) return;
    flushing.current = true;
    try {
      await api.post(`/v1/sessions/${session.id}/plays`, { plays: batch satisfies PlayEvent[] });
      recorder.current.ack(batch);
    } catch {
      /* kept in the queue and retried on the next flush */
    } finally {
      flushing.current = false;
    }
  }, [session]);

  // Record marks as the position moves.
  useEffect(() => {
    if (!status.isLoaded || status.duration <= 0) return;
    recorder.current.update(status.currentTime * 1000, status.duration * 1000);
  }, [status.currentTime, status.duration, status.isLoaded]);

  // Sync every 30 seconds while playing, when paused, and on leaving.
  useEffect(() => {
    if (!status.playing) {
      void flush();
      return;
    }
    const t = setInterval(() => void flush(), 30_000);
    return () => clearInterval(t);
  }, [status.playing, flush]);
  useEffect(() => () => void flush(), [flush]);

  const enableLockScreen = useCallback(
    (title: string) => {
      player.setActiveForLockScreen(
        true,
        { title, artist: 'Avanvu' },
        { showSeekBackward: true, showSeekForward: true },
      );
    },
    [player],
  );

  return {
    player,
    status,
    uri,
    online,
    error,
    flush,
    enableLockScreen,
    pending: () => recorder.current.pending().length,
  };
}
