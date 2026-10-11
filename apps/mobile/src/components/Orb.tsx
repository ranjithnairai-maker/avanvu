import { useEffect } from 'react';
import { View } from 'react-native';
import { Canvas, Circle, RadialGradient, vec } from '@shopify/react-native-skia';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { motion } from '@avanvu/core';
import { useTheme } from '@/theme/theme';

interface Props {
  size?: number;
  /** Runs the 4 s in, 2 s hold, 6 s out breathing guide (SPEC §7.6). Otherwise a slow ambient shimmer. */
  breathing?: boolean;
}

/** Soft glowing sphere. Fully static under Reduce Motion: no pulse, no shimmer. */
export function Orb({ size = 160, breathing = false }: Props) {
  const { colors, reduceMotion } = useTheme();
  const t = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      t.value = 0;
      return;
    }
    if (breathing) {
      const { inhaleMs, holdMs, exhaleMs } = motion.breathing;
      t.value = withRepeat(
        withSequence(
          withTiming(1, { duration: inhaleMs, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: holdMs }),
          withTiming(0, { duration: exhaleMs, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      );
    } else {
      t.value = withRepeat(
        withTiming(1, { duration: motion.durations.ambientMax * 2.5, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      );
    }
  }, [breathing, reduceMotion, t]);

  const c = size / 2;
  const radius = useDerivedValue(() => c * (breathing ? 0.62 + 0.3 * t.value : 0.8 + 0.06 * t.value));
  const glow = useDerivedValue(() => c * (breathing ? 0.9 : 0.95));

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Canvas style={{ width: size, height: size }}>
        <Circle cx={c} cy={c} r={glow} opacity={0.35}>
          <RadialGradient c={vec(c, c)} r={c} colors={[`${colors.ember}66`, `${colors.accent}00`]} />
        </Circle>
        <Circle cx={c} cy={c} r={radius}>
          <RadialGradient
            c={vec(c * 0.85, c * 0.8)}
            r={c}
            colors={[colors.ember, colors.accent, `${colors.accent}99`]}
            positions={[0, 0.6, 1]}
          />
        </Circle>
      </Canvas>
    </View>
  );
}
