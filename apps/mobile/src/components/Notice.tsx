import { View } from 'react-native';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

interface Props {
  kind?: 'info' | 'warning' | 'error';
  children: string;
}

/** Inline notice. Never colour alone: a leading symbol carries the meaning too (SPEC §7.5). */
export function Notice({ kind = 'info', children }: Props) {
  const { colors } = useTheme();
  const tone = kind === 'error' ? colors.danger : kind === 'warning' ? colors.warning : colors.accent;
  const symbol = kind === 'error' ? '⚠' : kind === 'warning' ? '!' : 'i';
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        gap: 12,
        padding: 16,
        borderRadius: radius.input,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: tone,
      }}
    >
      <Text variant="headline" style={{ color: tone }}>
        {symbol}
      </Text>
      <Text variant="callout" style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}
