import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import { colors, type ColorTokens, type ThemeName } from '@avanvu/core';

interface Theme {
  scheme: ThemeName;
  colors: ColorTokens;
  reduceMotion: boolean;
}

const ThemeContext = createContext<Theme | null>(null);

/** Dark is the default; the app follows the system appearance (SPEC §7.2). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const scheme: ThemeName = system === 'light' ? 'light' : 'dark';
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduceMotion(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const value = useMemo(() => ({ scheme, colors: colors[scheme], reduceMotion }), [scheme, reduceMotion]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error('useTheme must be used inside ThemeProvider');
  return t;
}
