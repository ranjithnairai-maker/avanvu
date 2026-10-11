import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { getBrand } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Orb } from '@/components/Orb';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { View } from 'react-native';

/**
 * Milestone 1 landing screen: brand hero plus entry points to the component gallery and the four
 * device spikes (SPEC §15). Onboarding (M3) replaces this screen; the dev menu is hidden in production.
 */
export default function Index() {
  const router = useRouter();
  const brand = getBrand();
  const env = (Constants.expoConfig?.extra as { env?: string } | undefined)?.env ?? 'local';
  const dev = env !== 'production';

  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: 16, paddingVertical: 32 }}>
        <Orb size={180} />
        <Text variant="display" style={{ textAlign: 'center' }}>
          {brand.tagline}
        </Text>
        <Text variant="body" tone="secondary" style={{ textAlign: 'center' }}>
          {brand.supportingLine}
        </Text>
      </View>
      {dev ? (
        <>
          <Text variant="caption" tone="tertiary" style={{ marginTop: 16 }}>
            Milestone 1 tools
          </Text>
          <Button label="Component gallery" onPress={() => router.push('/dev/gallery')} />
          <Button
            label="Spike: background playback"
            kind="secondary"
            onPress={() => router.push('/dev/spikes/audio')}
          />
          <Button
            label="Spike: age range"
            kind="secondary"
            onPress={() => router.push('/dev/spikes/age-range')}
          />
          <Button
            label="Spike: on-device dictation"
            kind="secondary"
            onPress={() => router.push('/dev/spikes/dictation')}
          />
        </>
      ) : null}
    </Screen>
  );
}
