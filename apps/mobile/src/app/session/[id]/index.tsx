import { useLocalSearchParams, useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { contextGradients, MIN_HIT_TARGET } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Orb } from '@/components/Orb';
import { Scaffold } from '@/components/Scaffold';
import { Scrubber } from '@/components/Scrubber';
import { Text } from '@/components/Text';
import { api } from '@/lib/api';
import { useSession, type SessionDto } from '@/lib/api/queries';
import { useSessionAudio } from '@/lib/player/useSessionAudio';
import { PlayRecorder } from '@/lib/player/plays';
import { useTheme } from '@/theme/theme';

const LINES = [
  'Placing you at the start line',
  'Finding the right words',
  'Choosing your pace',
  'Setting the scene',
  'Almost there',
];
const CONTEXT_TITLE = {
  training: 'Training session',
  night_before: 'Night before',
  primer: 'Pre-event primer',
} as const;
const SAFETY_SEEN = 'avanvu.player.safety.seen';

const mmss = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const startedAt = useRef(Date.now()).current;
  const q = useSession(id, startedAt);
  const s = q.data ?? null;
  if (!s || s.status === 'preparing' || s.status === 'voicing')
    return <Composing session={s} startedAt={startedAt} />;
  if (s.status === 'failed' || s.status === 'canceled') return <Failed session={s} />;
  return <Player session={s} />;
}

/** The wait, made graceful (SPEC §8.1 step 10, §8.3): honest timing, the athlete may leave, a push arrives when ready. */
function Composing({ session, startedAt }: { session: SessionDto | null; startedAt: number }) {
  const router = useRouter();
  const [line, setLine] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const a = setInterval(() => setLine((n) => (n + 1) % LINES.length), 3500);
    const b = setTimeout(() => setSlow(true), 180_000);
    return () => {
      clearInterval(a);
      clearTimeout(b);
    };
  }, []);
  void startedAt;
  return (
    <Scaffold
      footer={
        <Button
          label="Leave this screen"
          kind="text"
          onPress={() => router.replace('/')}
          accessibilityHint="Your session keeps preparing. We'll notify you when it's ready."
        />
      }
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, paddingVertical: 56 }}>
        <Orb size={180} breathing />
        <Text variant="title2" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
          {session?.status === 'voicing' ? 'Recording your voice' : LINES[line]}
        </Text>
        <Text variant="body" tone="secondary" style={{ textAlign: 'center' }}>
          {slow
            ? "Taking longer than usual. We'll notify you when it's ready."
            : "Usually 1 to 3 minutes. We'll notify you when it's ready."}
        </Text>
      </View>
    </Scaffold>
  );
}

function Failed({ session }: { session: SessionDto }) {
  const router = useRouter();
  return (
    <Scaffold
      title={session.status === 'canceled' ? 'Session canceled' : "We couldn't create this session"}
      subtitle={
        session.status === 'canceled'
          ? 'Your session allowance was returned.'
          : "Your session allowance wasn't used."
      }
      footer={<Button label="Try again" onPress={() => router.replace('/(tabs)/home')} />}
    >
      <Notice kind="info">Creating a session needs a connection. Try again in a moment.</Notice>
    </Scaffold>
  );
}

/** Press targets without haptics: playback stays calm (SPEC §7.6). */
function PlayerButton({
  symbol,
  label,
  size = MIN_HIT_TARGET,
  onPress,
  primary,
}: {
  symbol: string;
  label: string;
  size?: number;
  onPress: () => void;
  primary?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: primary ? colors.accent : colors.surfaceRaised,
      }}
    >
      <SymbolView
        name={symbol as never}
        size={size * 0.4}
        tintColor={primary ? colors.onAccent : colors.textPrimary}
      />
    </Pressable>
  );
}

function Player({ session }: { session: SessionDto }) {
  const router = useRouter();
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const audio = useSessionAudio(session);
  const { player, status } = audio;
  const [dim, setDim] = useState(session.context === 'night_before');
  const [showSafety, setShowSafety] = useState(false);
  const title = CONTEXT_TITLE[session.context];
  const tint = useMemo(() => contextGradients[session.context][scheme], [session.context, scheme]);

  useEffect(() => {
    SecureStore.getItemAsync(SAFETY_SEEN)
      .then((v) => !v && setShowSafety(true))
      .catch(() => undefined);
  }, []);

  // Finished: no completion sound; move to the check-in.
  useEffect(() => {
    if (status.didJustFinish) {
      void audio.flush();
      router.replace({ pathname: '/session/[id]/checkin', params: { id: session.id } });
    }
  }, [status.didJustFinish, audio, router, session.id]);

  const toggle = () => {
    if (status.playing) player.pause();
    else {
      audio.enableLockScreen(session.program_item_id ? title : title);
      player.play();
    }
  };
  const leave = () => {
    const prompt = PlayRecorder.shouldPromptCheckin(status.currentTime * 1000, status.duration * 1000);
    player.pause();
    void audio.flush();
    if (prompt) router.replace({ pathname: '/session/[id]/checkin', params: { id: session.id } });
    else router.replace('/');
  };

  if (dim) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Screen is dimmed. Tap to show controls."
        onPress={() => setDim(false)}
        style={{ flex: 1, backgroundColor: '#000' }}
      >
        <StatusBar hidden />
      </Pressable>
    );
  }

  const remaining = Math.max(0, status.duration - status.currentTime);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        paddingTop: insets.top,
        paddingBottom: Math.max(insets.bottom, 20),
      }}
    >
      <View
        pointerEvents="none"
        style={{ position: 'absolute', inset: 0, backgroundColor: tint, opacity: 0.12 }}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 20 }}>
        <PlayerButton symbol="chevron.down" label="Close player" onPress={leave} />
        <PlayerButton symbol="moon.fill" label="Dim the screen" onPress={() => setDim(true)} />
      </View>

      <View
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, paddingHorizontal: 24 }}
      >
        <Orb size={220} breathing={status.playing} />
        <Text variant="display" style={{ textAlign: 'center' }} accessibilityRole="header">
          {title}
        </Text>
        <Text variant="callout" tone="secondary">
          {session.length_min} minutes
        </Text>
      </View>

      {showSafety ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          <Notice kind="info">
            Please don't listen while driving, cycling, swimming, operating equipment or during play. You can
            stop at any time.
          </Notice>
          <Button
            kind="text"
            label="Got it"
            onPress={() => {
              setShowSafety(false);
              void SecureStore.setItemAsync(SAFETY_SEEN, '1');
            }}
          />
        </View>
      ) : null}

      <View style={{ paddingHorizontal: 24, gap: 8 }}>
        <Scrubber
          positionSeconds={status.currentTime}
          durationSeconds={status.duration}
          onSeek={(sec) => player.seekTo(sec)}
        />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="callout" tone="secondary" tabular>
            {mmss(status.currentTime)}
          </Text>
          <Text variant="callout" tone="secondary" tabular>
            -{mmss(remaining)}
          </Text>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 32,
            marginVertical: 12,
          }}
        >
          <PlayerButton
            symbol="gobackward.15"
            label="Back 15 seconds"
            onPress={() => player.seekTo(Math.max(0, status.currentTime - 15))}
          />
          <PlayerButton
            symbol={status.playing ? 'pause.fill' : 'play.fill'}
            label={status.playing ? 'Pause' : 'Play'}
            size={72}
            primary
            onPress={toggle}
          />
          <PlayerButton
            symbol="goforward.15"
            label="Forward 15 seconds"
            onPress={() => player.seekTo(Math.min(status.duration, status.currentTime + 15))}
          />
        </View>
        {audio.error ? <Notice kind="error">{audio.error}</Notice> : null}
        <Button
          kind="text"
          label="Transcript"
          onPress={() => {
            AccessibilityInfo.announceForAccessibility('Opening transcript');
            router.push({ pathname: '/session/[id]/transcript', params: { id: session.id } });
          }}
        />
        {audio.online ? (
          <Text variant="caption" tone="tertiary" style={{ textAlign: 'center' }}>
            Streaming. Save this session to listen offline.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

void api;
