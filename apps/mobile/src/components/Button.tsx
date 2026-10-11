import { useEffect } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { MIN_HIT_TARGET, motion, radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

type Kind = 'primary' | 'secondary' | 'text';

interface Props {
  label: string;
  onPress?: () => void;
  kind?: Kind;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

function Dot({ color, index }: { color: string; index: number }) {
  const { reduceMotion } = useTheme();
  const opacity = useSharedValue(reduceMotion ? 0.6 : 0.3);
  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 0.6;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(1, { duration: 300 + index * 80 }), withTiming(0.3, { duration: 300 })),
      -1,
    );
  }, [reduceMotion, index, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, style]} />;
}

/** Three-dot pulse shown while loading; static under Reduce Motion. */
function Dots({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} color={color} index={i} />
      ))}
    </View>
  );
}

/** Primary 56 pt button: scale 0.97 spring and a light haptic on press (SPEC §7.5). */
export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  accessibilityHint,
  style,
}: Props) {
  const { colors, scheme, reduceMotion } = useTheme();
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const inactive = disabled || loading;

  const container: ViewStyle =
    kind === 'primary'
      ? {
          backgroundColor: colors.accent,
          ...(scheme === 'dark'
            ? {
                shadowColor: colors.accent,
                shadowOpacity: 0.3,
                shadowRadius: 16,
                shadowOffset: { width: 0, height: 4 },
              }
            : {}),
        }
      : kind === 'secondary'
        ? { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong }
        : {};
  const textTone = kind === 'primary' ? 'onAccent' : kind === 'secondary' ? 'primary' : 'accent';
  const dotColor = kind === 'primary' ? colors.onAccent : colors.accent;

  return (
    <Animated.View style={[anim, kind !== 'text' && { width: '100%' }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !!inactive, busy: !!loading }}
        disabled={inactive}
        onPressIn={() => {
          if (!reduceMotion) scale.value = withSpring(0.97, motion.spring);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, motion.spring);
        }}
        onPress={() => {
          if (kind === 'primary') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress?.();
        }}
        style={[
          {
            minHeight: kind === 'text' ? MIN_HIT_TARGET : 56,
            borderRadius: radius.button,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 20,
            paddingVertical: 12,
            opacity: disabled ? 0.4 : 1,
          },
          container,
        ]}
      >
        {loading ? (
          <Dots color={dotColor} />
        ) : (
          <Text variant="headline" tone={textTone}>
            {label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}
