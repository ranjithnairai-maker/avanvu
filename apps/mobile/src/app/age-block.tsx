import { useLocalSearchParams } from 'expo-router';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';

/** Respectful block screen. Nothing was stored, and there is no button because there is nothing to continue to. */
export default function AgeBlock() {
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  return (
    <Scaffold
      title={reason === 'sharing_required' ? 'We need your age to continue' : 'Avanvu is for adults'}
      subtitle={
        reason === 'sharing_required'
          ? 'In your region, apps need to confirm age before you can use them. You can allow Avanvu to see your age range in Settings > Apple Account, then open Avanvu again.'
          : "Avanvu is for people aged 18 or older. Thank you for checking, and we hope to see you when you're older."
      }
    >
      <Text variant="callout" tone="tertiary">
        We haven't saved anything about you.
      </Text>
    </Scaffold>
  );
}
