import { Pressable } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { MIN_HIT_TARGET } from '@avanvu/core';
import { useTheme } from '@/theme/theme';

interface Props {
  symbol: SFSymbol;
  /** Required: every icon button is labelled for VoiceOver (SPEC §7.5). */
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}

export function IconButton({ symbol, label, onPress, disabled }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        Haptics.selectionAsync();
        onPress?.();
      }}
      style={{
        width: MIN_HIT_TARGET,
        height: MIN_HIT_TARGET,
        borderRadius: MIN_HIT_TARGET / 2,
        backgroundColor: colors.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <SymbolView name={symbol} size={20} tintColor={colors.textPrimary} />
    </Pressable>
  );
}
