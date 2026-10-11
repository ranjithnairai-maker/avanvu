import { useEffect } from 'react';
import type { DimensionValue } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';

/** Low-contrast shimmer on surfaceRaised; static under Reduce Motion. Never a full-screen spinner. */
export function Skeleton({ width = '100%', height = 20 }: { width?: DimensionValue; height?: number }) {
  const { colors, reduceMotion } = useTheme();
  const o = useSharedValue(0.6);
  useEffect(() => {
    if (reduceMotion) {
      o.value = 0.8;
      return;
    }
    o.value = withRepeat(withTiming(1, { duration: 1000 }), -1, true);
  }, [reduceMotion, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius.chip, backgroundColor: colors.surfaceRaised }, style]}
    />
  );
}
