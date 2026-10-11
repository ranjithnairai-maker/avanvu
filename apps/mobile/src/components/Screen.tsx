import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { layout } from '@avanvu/core';
import { useTheme } from '@/theme/theme';

/** Scrolls rather than truncating at large Dynamic Type sizes; 20 pt side padding (SPEC §7.4). */
export function Screen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: layout.screenPadding, gap: layout.cardGap, paddingBottom: 56 }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
