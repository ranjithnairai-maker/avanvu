import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { typography, type TypeStyleName } from '@avanvu/core';
import { useTheme } from '@/theme/theme';

type Tone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'danger' | 'success' | 'onAccent';

interface Props extends TextProps {
  variant?: TypeStyleName;
  tone?: Tone;
  tabular?: boolean;
}

const MANROPE: Record<string, string> = { '600': 'Manrope_600SemiBold', '700': 'Manrope_700Bold' };

/** All styles scale with Dynamic Type with no cap (SPEC §7.3): no maxFontSizeMultiplier is set. */
export function Text({ variant = 'body', tone = 'primary', tabular, style, ...rest }: Props) {
  const { colors } = useTheme();
  const t = typography[variant];
  const color = {
    primary: colors.textPrimary,
    secondary: colors.textSecondary,
    tertiary: colors.textTertiary,
    accent: colors.accent,
    danger: colors.danger,
    success: colors.success,
    onAccent: colors.onAccent,
  }[tone];
  const base: TextStyle = {
    color,
    fontSize: t.size,
    lineHeight: t.lineHeight,
    ...(t.family === 'Manrope' ? { fontFamily: MANROPE[t.weight] } : { fontWeight: t.weight }),
    ...(t.letterSpacing !== undefined ? { letterSpacing: t.letterSpacing } : {}),
    ...(tabular ? { fontVariant: ['tabular-nums'] as TextStyle['fontVariant'] } : {}),
  };
  return <RNText {...rest} style={[base, style]} />;
}
