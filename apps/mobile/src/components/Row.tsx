import type { ReactNode } from 'react';
import { Pressable, Switch, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

interface RowProps {
  title: string;
  subtitle?: string;
  accessory?: ReactNode;
  onPress?: () => void;
  accessibilityHint?: string;
  destructive?: boolean;
}

/** A 56 pt row for lists and settings (SPEC §7.5). */
export function Row({ title, subtitle, accessory, onPress, accessibilityHint, destructive }: RowProps) {
  const { colors } = useTheme();
  const content = (
    <View
      style={{
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        borderRadius: radius.input,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" tone={destructive ? 'danger' : 'primary'}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="callout" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {accessory}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
    >
      {content}
    </Pressable>
  );
}

interface ToggleProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

/** A labelled switch row; the whole row is the target (SPEC §7.8: 44 pt). */
export function Toggle({ label, description, value, onChange }: ToggleProps) {
  const { colors } = useTheme();
  return (
    <Row
      title={label}
      {...(description ? { subtitle: description } : {})}
      accessory={
        <Switch
          value={value}
          onValueChange={(v) => {
            Haptics.selectionAsync();
            onChange(v);
          }}
          trackColor={{ true: colors.accent, false: colors.surfaceRaised }}
          accessibilityLabel={label}
        />
      }
    />
  );
}
