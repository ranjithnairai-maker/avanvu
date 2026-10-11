import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

interface Props {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
  /** The one primary action, pinned at the bottom within thumb reach (SPEC §7.1). */
  footer?: ReactNode;
  scroll?: boolean;
}

/** Standard screen: large title, scrolling content (never truncating at large Dynamic Type), pinned footer. */
export function Scaffold({ title, subtitle, children, footer, scroll = true }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const body = (
    <View style={{ padding: layout.screenPadding, gap: layout.cardGap, flexGrow: 1 }}>
      {title ? (
        <View style={{ gap: 8, marginBottom: 8 }}>
          <Text variant="title1" accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="body" tone="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: insets.top, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingTop: insets.top }}>{body}</View>
      )}
      {footer ? (
        <View style={{ padding: layout.screenPadding, paddingBottom: Math.max(insets.bottom, 16), gap: 12 }}>
          {footer}
        </View>
      ) : null}
    </View>
  );
}
