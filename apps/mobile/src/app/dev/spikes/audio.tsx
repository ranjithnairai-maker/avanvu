import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { buildSpikeWav } from '@/lib/testTone';

const FILE_NAME = 'avanvu-spike-playback.wav';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Spike (b): background and lock-screen playback of a downloaded file, after locking and after restarting
 * the app (docs/device-tests/M1.md). The file lives in the Documents directory, like real sessions will.
 */
export default function AudioSpike() {
  const [uri, setUri] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const player = useAudioPlayer(uri ?? undefined);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch((e: unknown) => setNote(`Audio mode failed: ${e instanceof Error ? e.message : 'unknown'}`));
    const f = new File(Paths.document, FILE_NAME);
    if (f.exists) setUri(f.uri);
  }, []);

  const generate = useCallback(() => {
    const f = new File(Paths.document, FILE_NAME);
    if (f.exists) f.delete();
    f.create();
    f.write(buildSpikeWav(300));
    setUri(f.uri);
    setNote(`Wrote ${(f.size / 1_000_000).toFixed(1)} MB to the Documents directory.`);
  }, []);

  const lockScreen = useCallback(() => {
    player.setActiveForLockScreen(
      true,
      { title: 'Avanvu spike', artist: 'Avanvu' },
      { showSeekBackward: true, showSeekForward: true },
    );
    setNote('Lock screen controls enabled.');
  }, [player]);

  return (
    <Screen>
      <Card>
        <Text variant="headline">Test file</Text>
        <Text variant="callout" tone="secondary">
          {uri
            ? 'Found in Documents. It should still be here after you restart the app.'
            : 'Not generated yet.'}
        </Text>
      </Card>
      <Button label="Generate 5 minute test file" kind="secondary" onPress={generate} />
      <Button
        label={status.playing ? 'Pause' : 'Play'}
        disabled={!uri}
        onPress={() => (status.playing ? player.pause() : player.play())}
      />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Button
            label="Back 15 s"
            kind="secondary"
            disabled={!uri}
            onPress={() => player.seekTo(Math.max(0, status.currentTime - 15))}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label="Forward 15 s"
            kind="secondary"
            disabled={!uri}
            onPress={() => player.seekTo(status.currentTime + 15)}
          />
        </View>
      </View>
      <Button label="Enable lock screen controls" kind="secondary" disabled={!uri} onPress={lockScreen} />
      <Text variant="body" tabular>
        {fmt(status.currentTime)} / {fmt(status.duration)} {status.playing ? 'playing' : 'paused'}
      </Text>
      {note ? (
        <Text variant="callout" tone="secondary">
          {note}
        </Text>
      ) : null}
    </Screen>
  );
}
