import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import { SymbolView } from 'expo-symbols';
import { radius } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { IconButton } from '@/components/IconButton';
import { Notice } from '@/components/Notice';
import { Orb } from '@/components/Orb';
import { Text } from '@/components/Text';
import { revealSteps, type ChatMessage } from '@/lib/intake/chat';
import { useDictation } from '@/lib/intake/useDictation';
import { useIntake } from '@/lib/intake/useIntake';
import { useTheme } from '@/theme/theme';

/** Interview chat (SPEC §4, §8.2): warm bubbles, one question at a time, quick replies, resumable. */
export default function IntakeChat() {
  const router = useRouter();
  const { id, event } = useLocalSearchParams<{ id?: string; event?: string }>();
  const { state, dispatch, loading, loadError, reload, send, pause, resume, canSend } = useIntake({
    id,
    event,
  });
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const [online, setOnline] = useState(true);
  const dictation = useDictation((text) => dispatch({ type: 'composer', text }));

  useEffect(() => NetInfo.addEventListener((s) => setOnline(s.isConnected !== false)), []);
  useEffect(() => {
    if (state.safetyInterrupted) router.replace('/safety');
  }, [state.safetyInterrupted, router]);

  if (loading && !state.conversationId) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <Orb size={120} />
        <Text variant="callout" tone="secondary">
          Getting ready
        </Text>
      </View>
    );
  }
  if (loadError && !state.conversationId) {
    return (
      <View
        style={{ flex: 1, backgroundColor: colors.bg, padding: 20, paddingTop: insets.top + 20, gap: 16 }}
      >
        <Notice kind="error">{loadError}</Notice>
        <Button label="Try again" onPress={reload} />
      </View>
    );
  }

  const paused = state.convState === 'PAUSED';
  const progress = state.progress;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.bg }}
    >
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 12, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="headline" accessibilityRole="header">
            Your interview
          </Text>
          <IconButton
            symbol="pause.fill"
            label="Save and exit"
            onPress={async () => {
              await pause().catch(() => undefined);
              router.replace('/');
            }}
          />
        </View>
        {progress ? (
          <View
            accessible
            accessibilityLabel={`Step ${Math.min(progress.phases_complete + 1, progress.phases_total)} of ${progress.phases_total}`}
            style={{ flexDirection: 'row', gap: 4 }}
          >
            {Array.from({ length: progress.phases_total }, (_, i) => (
              <View
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: i < progress.phases_complete ? colors.accent : colors.surfaceRaised,
                }}
              />
            ))}
          </View>
        ) : null}
      </View>

      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, gap: 12 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: !reduceMotion })}
        keyboardShouldPersistTaps="handled"
      >
        {state.messages.map((m) => (
          <Bubble
            key={m.id}
            message={m}
            reveal={state.revealing === m.id}
            onRevealed={() => dispatch({ type: 'revealDone' })}
          />
        ))}
        {state.sending ? <TypingDots /> : null}
        {state.quickReplies.length > 0 && !state.sending ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {state.quickReplies.map((q) => (
              <Chip key={q} label={q} onPress={() => void send(q, 'quick_reply')} />
            ))}
          </View>
        ) : null}
        {state.error ? <Notice kind="error">{state.error.message}</Notice> : null}
        {!online ? (
          <Notice kind="info">You're offline. Your answer stays in the box until you reconnect.</Notice>
        ) : null}
      </ScrollView>

      {state.summaryAvailable ? (
        <View style={{ padding: 20, paddingBottom: Math.max(insets.bottom, 16) }}>
          <Button
            label="See my summary"
            onPress={() =>
              router.replace({ pathname: '/intake/summary', params: { id: state.conversationId ?? '' } })
            }
          />
        </View>
      ) : paused ? (
        <View style={{ padding: 20, paddingBottom: Math.max(insets.bottom, 16), gap: 12 }}>
          <Notice kind="info">Your interview is paused. Pick up where you left off.</Notice>
          <Button label="Resume" onPress={() => void resume()} />
        </View>
      ) : (
        <Composer
          value={state.composer}
          onChange={(t) => dispatch({ type: 'composer', text: t })}
          disabled={state.sending}
          canSend={canSend && online}
          onSend={() => void send(state.composer)}
          bottomInset={insets.bottom}
          mic={
            dictation.available
              ? {
                  listening: dictation.listening,
                  onPress: () => (dictation.listening ? dictation.stop() : void dictation.start()),
                }
              : null
          }
        />
      )}
    </KeyboardAvoidingView>
  );
}

function Bubble({
  message,
  reveal,
  onRevealed,
}: {
  message: ChatMessage;
  reveal: boolean;
  onRevealed: () => void;
}) {
  const { colors, reduceMotion } = useTheme();
  const steps = useRef(revealSteps(message.text)).current;
  const [shown, setShown] = useState(reveal && !reduceMotion ? 0 : steps.length - 1);
  const mine = message.role === 'athlete';

  useEffect(() => {
    if (!reveal) return;
    if (reduceMotion) {
      onRevealed();
      AccessibilityInfo.announceForAccessibility(message.text);
      return;
    }
    const t = setInterval(() => {
      setShown((n) => {
        if (n >= steps.length - 1) {
          clearInterval(t);
          onRevealed();
          // VoiceOver hears only the completed message, not every word (SPEC §7.8).
          AccessibilityInfo.announceForAccessibility(message.text);
          return n;
        }
        return n + 1;
      });
    }, 70);
    return () => clearInterval(t);
  }, [reveal]);

  const text = steps[Math.min(shown, steps.length - 1)] ?? message.text;
  const revealing = reveal && shown < steps.length - 1;
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <View
        accessible={!revealing}
        accessibilityLabel={revealing ? undefined : `${mine ? 'You' : 'Avanvu'}: ${message.text}`}
        importantForAccessibility={revealing ? 'no-hide-descendants' : 'yes'}
        style={{
          maxWidth: '86%',
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderRadius: radius.card,
          backgroundColor: mine ? `${colors.accent}26` : colors.surface,
          borderWidth: mine ? 0 : 1,
          borderColor: colors.border,
          opacity: message.status === 'pending' ? 0.6 : 1,
        }}
      >
        <Text variant="body">{text}</Text>
      </View>
    </View>
  );
}

function TypingDots() {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="Avanvu is thinking"
      style={{
        alignSelf: 'flex-start',
        padding: 16,
        borderRadius: radius.card,
        backgroundColor: colors.surface,
        flexDirection: 'row',
        gap: 6,
      }}
    >
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textTertiary }}
        />
      ))}
    </View>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  disabled,
  canSend,
  bottomInset,
  mic,
}: {
  value: string;
  onChange: (t: string) => void;
  onSend: () => void;
  disabled: boolean;
  canSend: boolean;
  bottomInset: number;
  mic: { listening: boolean; onPress: () => void } | null;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 12,
        padding: 12,
        paddingBottom: Math.max(bottomInset, 12),
      }}
    >
      {mic ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mic.listening ? 'Stop dictation' : 'Dictate your answer'}
          onPress={mic.onPress}
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: mic.listening ? colors.accent : colors.surfaceRaised,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SymbolView
            name={mic.listening ? 'stop.fill' : 'mic.fill'}
            size={22}
            tintColor={mic.listening ? colors.onAccent : colors.textPrimary}
          />
        </Pressable>
      ) : null}
      <TextInput
        accessibilityLabel="Your answer"
        placeholder="Type your answer"
        placeholderTextColor={colors.textTertiary}
        value={value}
        onChangeText={onChange}
        multiline
        maxLength={1000}
        editable={!disabled}
        style={{
          flex: 1,
          minHeight: 52,
          maxHeight: 5 * 24 + 28,
          borderRadius: radius.input,
          paddingHorizontal: 16,
          paddingVertical: 14,
          fontSize: 17,
          color: colors.textPrimary,
          backgroundColor: colors.surfaceRaised,
          borderWidth: 1,
          borderColor: colors.borderStrong,
        }}
      />
      {value.trim().length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={onSend}
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: colors.accent,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: canSend ? 1 : 0.4,
          }}
        >
          <SymbolView name="arrow.up" size={22} tintColor={colors.onAccent} />
        </Pressable>
      ) : null}
    </View>
  );
}
