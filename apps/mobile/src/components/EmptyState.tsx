import { View } from 'react-native';
import { Button } from './Button';
import { Orb } from './Orb';
import { Text } from './Text';

/** The orb, one sentence, one button (SPEC §7.5). */
export function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <View style={{ alignItems: 'center', gap: 20, paddingVertical: 24 }}>
      <Orb size={96} />
      <Text variant="body" tone="secondary" style={{ textAlign: 'center' }}>
        {message}
      </Text>
      <Button label={actionLabel} kind="secondary" onPress={onAction} />
    </View>
  );
}
