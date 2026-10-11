/** Colour tokens, SPEC §7.2. Never hard-code colours in screens. */
export type ThemeName = 'dark' | 'light';

export interface ColorTokens {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  onAccent: string;
  ember: string;
  emberText: string;
  success: string;
  warning: string;
  danger: string;
}

export const colors: Record<ThemeName, ColorTokens> = {
  dark: {
    bg: '#0B0F1A',
    surface: '#121826',
    surfaceRaised: '#1A2233',
    border: '#263046',
    borderStrong: '#566C9E',
    textPrimary: '#F4F6FB',
    textSecondary: '#A3ACC2',
    textTertiary: '#818AA2',
    accent: '#7C9CFF',
    onAccent: '#0B0F1A',
    ember: '#FFB36B',
    emberText: '#FFB36B',
    success: '#4FD1A5',
    warning: '#F5C26B',
    danger: '#FF7A7A',
  },
  light: {
    bg: '#F7F8FB',
    surface: '#FFFFFF',
    surfaceRaised: '#F0F2F7',
    border: '#E2E6EF',
    borderStrong: '#788AB4',
    textPrimary: '#0E1424',
    textSecondary: '#4B5570',
    textTertiary: '#636D85',
    accent: '#3B5EF1',
    onAccent: '#FFFFFF',
    ember: '#E8893A',
    emberText: '#A85714',
    success: '#187C5B',
    warning: '#8C6718',
    danger: '#CE2D2D',
  },
};

/** Context gradients: 15-25 % opacity over `bg`, never large solid fills. */
export const contextGradients = {
  training: { dark: colors.dark.accent, light: colors.light.accent },
  night_before: { dark: '#6E62E5', light: '#6E62E5' },
  primer: { dark: colors.dark.ember, light: colors.light.ember },
} as const;
