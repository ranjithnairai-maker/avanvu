import { useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useTheme } from '@/theme/theme';

interface Props {
  positionSeconds: number;
  durationSeconds: number;
  onSeek: (seconds: number) => void;
  label?: string;
}

/** Seek bar. Seeking is never blocked (SPEC §6.5). No haptics: playback must stay calm. */
export function Scrubber({ positionSeconds, durationSeconds, onSeek, label = 'Playback position' }: Props) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const ratio = durationSeconds > 0 ? Math.min(1, positionSeconds / durationSeconds) : 0;
  const seekTo = (x: number) => {
    if (width > 0 && durationSeconds > 0) onSeek(Math.max(0, Math.min(1, x / width)) * durationSeconds);
  };
  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => runOnJS(seekTo)(e.x))
    .onUpdate((e) => runOnJS(seekTo)(e.x));
  return (
    <GestureDetector gesture={pan}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: Math.round(durationSeconds), now: Math.round(positionSeconds) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) =>
          onSeek(Math.max(0, positionSeconds + (e.nativeEvent.actionName === 'increment' ? 15 : -15)))
        }
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height: 44, justifyContent: 'center' }}
      >
        <View
          style={{
            height: 6,
            borderRadius: 3,
            backgroundColor: colors.surfaceRaised,
            borderWidth: 1,
            borderColor: colors.borderStrong,
          }}
        >
          <View
            style={{
              width: `${ratio * 100}%`,
              height: '100%',
              borderRadius: 3,
              backgroundColor: colors.accent,
            }}
          />
        </View>
        <View
          style={{
            position: 'absolute',
            left: Math.max(0, ratio * width - 8),
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: colors.accent,
          }}
        />
      </View>
    </GestureDetector>
  );
}
