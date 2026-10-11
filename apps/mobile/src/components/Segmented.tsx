import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { motion, radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

interface Props<T extends string> {
  options: readonly { value: T; label: string }[];
  /** Null shows no selection yet. */
  value: T | null;
  onChange: (v: T) => void;
}

/** 2 to 4 options; pill track on surfaceRaised with a sliding thumb on surface (SPEC §7.5). */
export function Segmented<T extends string>({ options, value, onChange }: Props<T>) {
  const { colors, reduceMotion } = useTheme();
  const [width, setWidth] = useState(0);
  const seg = options.length > 0 ? (width - 8) / options.length : 0;
  const found = options.findIndex((o) => o.value === value);
  const index = Math.max(0, found);
  const x = useSharedValue(0);
  x.value = reduceMotion ? index * seg : withSpring(index * seg, motion.spring);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        flexDirection: 'row',
        padding: 4,
        borderRadius: radius.full,
        backgroundColor: colors.surfaceRaised,
      }}
    >
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: 4,
            left: 4,
            bottom: 4,
            width: seg,
            borderRadius: radius.full,
            backgroundColor: colors.surface,
          },
          thumb,
          { opacity: found < 0 ? 0 : 1 },
        ]}
      />
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="tab"
          accessibilityLabel={o.label}
          accessibilityState={{ selected: o.value === value }}
          onPress={() => {
            Haptics.selectionAsync();
            onChange(o.value);
          }}
          style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text variant="callout" tone={o.value === value ? 'primary' : 'secondary'}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
