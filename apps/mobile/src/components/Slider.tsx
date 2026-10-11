import { useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Text } from './Text';
import { useTheme } from '@/theme/theme';

interface Props {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}

const THUMB = 28;
const TRACK = 6;

/** Integer slider (vividness and readiness 1 to 5): haptic tick per value, VoiceOver adjustable (SPEC §7.5). */
export function Slider({ label, value, min = 1, max = 5, onChange }: Props) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const steps = max - min;
  const usable = Math.max(1, width - THUMB);
  const x = ((value - min) / steps) * usable;

  const commit = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== value) {
      Haptics.selectionAsync();
      onChange(clamped);
    }
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => runOnJS(commit)(min + Math.round(((e.x - THUMB / 2) / usable) * steps)))
    .onUpdate((e) => runOnJS(commit)(min + Math.round(((e.x - THUMB / 2) / usable) * steps)));

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="caption" tone="secondary">
          {label}
        </Text>
        <Text variant="caption" tabular>
          {value}
        </Text>
      </View>
      <GestureDetector gesture={pan}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityValue={{ min, max, now: value }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => commit(value + (e.nativeEvent.actionName === 'increment' ? 1 : -1))}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          style={{ height: 44, justifyContent: 'center' }}
        >
          <View
            style={{
              height: TRACK,
              borderRadius: TRACK / 2,
              backgroundColor: colors.surfaceRaised,
              borderWidth: 1,
              borderColor: colors.borderStrong,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: x,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: colors.accent,
            }}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
