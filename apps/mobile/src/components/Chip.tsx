import { Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

interface Props {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}

/** Pill chip: height 36 minimum, grows with Dynamic Type. Selected: 1.5 px accent border, 12 % fill, check. */
export function Chip({ label, selected, onPress }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected }}
      onPress={() => {
        Haptics.selectionAsync();
        onPress?.();
      }}
      style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
    >
      <Text
        variant="callout"
        style={{
          minHeight: 36,
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderRadius: radius.full,
          overflow: 'hidden',
          borderWidth: selected ? 1.5 : 1,
          borderColor: selected ? colors.accent : colors.borderStrong,
          backgroundColor: selected ? `${colors.accent}1F` : colors.surfaceRaised,
        }}
      >
        {selected ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}
