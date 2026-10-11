import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

const TOAST_MS = 2500;
const ToastContext = createContext<(message: string) => void>(() => {});

export const useToast = () => useContext(ToastContext);

/** Top pill, 2.5 s, slide and fade; announced to VoiceOver (SPEC §7.5). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((m: string) => {
    setMessage(m);
    AccessibilityInfo.announceForAccessibility(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {message ? (
        <Animated.View
          entering={reduceMotion ? undefined : FadeInUp.duration(250)}
          exiting={reduceMotion ? undefined : FadeOutUp.duration(150)}
          accessibilityLiveRegion="polite"
          style={{
            position: 'absolute',
            top: insets.top + 8,
            alignSelf: 'center',
            maxWidth: '90%',
            paddingVertical: 12,
            paddingHorizontal: 20,
            borderRadius: radius.full,
            backgroundColor: colors.surfaceRaised,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text variant="callout">{message}</Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}
