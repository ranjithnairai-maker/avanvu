import { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

interface Props extends Omit<TextInputProps, 'style'> {
  label: string;
  /** Shown below in danger colour with an icon, never colour alone (SPEC §7.5). */
  error?: string;
}

export function TextField({ label, error, onFocus, onBlur, ...rest }: Props) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
      <TextInput
        {...rest}
        accessibilityLabel={label}
        placeholderTextColor={colors.textTertiary}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={{
          minHeight: 52,
          borderRadius: radius.input,
          paddingHorizontal: 16,
          paddingVertical: 12,
          fontSize: 17,
          color: colors.textPrimary,
          backgroundColor: colors.surfaceRaised,
          borderWidth: focused ? 1.5 : 1,
          borderColor: error ? colors.danger : focused ? colors.accent : colors.borderStrong,
        }}
      />
      {error ? (
        <Text variant="callout" tone="danger" accessibilityLiveRegion="polite">
          {'⚠ '}
          {error}
        </Text>
      ) : null}
    </View>
  );
}
