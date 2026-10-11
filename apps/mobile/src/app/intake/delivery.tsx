import { useAudioPlayer } from 'expo-audio';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { radius, type MusicStyleName } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Notice } from '@/components/Notice';
import { Toggle } from '@/components/Row';
import { Scaffold } from '@/components/Scaffold';
import { Segmented } from '@/components/Segmented';
import { Text } from '@/components/Text';
import { api, ApiError } from '@/lib/api';
import { useTheme } from '@/theme/theme';

interface Voice {
  id: string;
  label: string;
  sample_url: string | null;
}

const STYLES: { value: MusicStyleName; label: string }[] = [
  { value: 'ambient_warm', label: 'Ambient warm' },
  { value: 'ambient_airy', label: 'Ambient airy' },
  { value: 'low_drone', label: 'Low drone' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'voice_only', label: 'Voice only' },
];

/** Delivery preferences (SPEC §8.1 step 9): three voices with samples, music style, perspective and lengths. */
export default function Delivery() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const settings = mode === 'settings';
  const { colors } = useTheme();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [style, setStyle] = useState<MusicStyleName>('ambient_warm');
  const [perspective, setPerspective] = useState<'first_person' | 'third_person'>('first_person');
  const [training, setTraining] = useState<10 | 15>(15);
  const [primer, setPrimer] = useState<3 | 5>(5);
  const [feared, setFeared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<string | null>(null);
  const player = useAudioPlayer(sample ?? undefined);
  const key = useRef(api.newKey());

  useEffect(() => {
    api
      .get<{ voices: Voice[] }>('/v1/voices')
      .then((r) => {
        setVoices(r.voices);
        if (r.voices[0]) setVoiceId((v) => v || (r.voices[0] as Voice).id);
      })
      .catch(() => setError("We couldn't load the voices. Check your connection and try again."));
  }, []);
  useEffect(() => {
    if (sample) player.play();
  }, [sample, player]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/v1/profile/preferences', {
        perspective,
        voice_id: voiceId,
        music_style: style,
        training_length_min: training,
        primer_length_min: primer,
        feared_self_enabled: feared,
      });
      if (settings) {
        router.back();
        return;
      }
      const s = await api.post<{ id: string }>(
        '/v1/sessions',
        { program_item_id: null, context: 'training', length_min: training },
        { idempotencyKey: key.current },
      );
      router.replace({ pathname: '/session/[id]', params: { id: s.id } });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      key.current = api.newKey();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Scaffold
      title="Make it yours"
      subtitle="Choose how your sessions sound. You can change this any time."
      footer={
        <Button
          label={settings ? 'Save' : 'Create my first session'}
          loading={busy}
          disabled={!voiceId}
          onPress={create}
        />
      }
    >
      <Text variant="caption" tone="secondary" accessibilityRole="header">
        Voice
      </Text>
      {voices.map((v) => (
        <Pressable
          key={v.id}
          accessibilityRole="button"
          accessibilityLabel={`${v.label} voice`}
          accessibilityState={{ selected: voiceId === v.id }}
          onPress={() => setVoiceId(v.id)}
          style={{
            padding: 16,
            minHeight: 72,
            borderRadius: radius.card,
            backgroundColor: colors.surface,
            borderWidth: voiceId === v.id ? 1.5 : 1,
            borderColor: voiceId === v.id ? colors.accent : colors.border,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text variant="headline">{v.label}</Text>
          {v.sample_url ? (
            <Text
              variant="callout"
              tone="accent"
              onPress={() => setSample(v.sample_url)}
              accessibilityRole="button"
              accessibilityLabel={`Play ${v.label} sample`}
            >
              Hear a sample
            </Text>
          ) : null}
        </Pressable>
      ))}

      <Text variant="caption" tone="secondary" accessibilityRole="header" style={{ marginTop: 12 }}>
        Music
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {STYLES.map((s) => (
          <Chip
            key={s.value}
            label={s.label}
            selected={style === s.value}
            onPress={() => setStyle(s.value)}
          />
        ))}
      </View>

      <Text variant="caption" tone="secondary" accessibilityRole="header" style={{ marginTop: 12 }}>
        Perspective
      </Text>
      <Segmented
        options={[
          { value: 'first_person', label: 'First person' },
          { value: 'third_person', label: 'Third person' },
        ]}
        value={perspective}
        onChange={setPerspective}
      />

      <Text variant="caption" tone="secondary" accessibilityRole="header" style={{ marginTop: 12 }}>
        Training session length
      </Text>
      <Segmented
        options={[
          { value: '10', label: '10 min' },
          { value: '15', label: '15 min' },
        ]}
        value={String(training) as '10' | '15'}
        onChange={(v) => setTraining(Number(v) as 10 | 15)}
      />
      <Text variant="caption" tone="secondary" accessibilityRole="header" style={{ marginTop: 12 }}>
        Pre-event primer length
      </Text>
      <Segmented
        options={[
          { value: '3', label: '3 min' },
          { value: '5', label: '5 min' },
        ]}
        value={String(primer) as '3' | '5'}
        onChange={(v) => setPrimer(Number(v) as 3 | 5)}
      />
      <Toggle
        label="Include a brief look at who you don't want to be"
        description="A few seconds in training sessions, then released. Turn off to remove it everywhere."
        value={feared}
        onChange={setFeared}
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
