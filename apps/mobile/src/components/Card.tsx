import type { ReactNode } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { contextGradients, motion, radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';

interface Props {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Tints the card with the context colour at 15 to 25 % opacity over `surface` (SPEC §7.2). */
  context?: keyof typeof contextGradients;
}

export function Card({ children, onPress, accessibilityLabel, context }: Props) {
  const { colors, scheme, reduceMotion } = useTheme();
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const base: ViewStyle = {
    borderRadius: radius.card,
    padding: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  };
  const tint = context ? (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: contextGradients[context][scheme],
        opacity: 0.18,
      }}
    />
  ) : null;
  const content = (
    <View style={base}>
      {tint}
      {children}
    </View>
  );
  if (!onPress) return content;
  return (
    <Animated.View style={anim}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPressIn={() => {
          if (!reduceMotion) scale.value = withSpring(0.98, motion.spring);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, motion.spring);
        }}
        onPress={onPress}
      >
        {content}
      </Pressable>
    </Animated.View>
  );
}
