import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { getBrand } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Orb } from '@/components/Orb';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';

export default function Welcome() {
  const router = useRouter();
  const brand = getBrand();
  return (
    <Scaffold
      scroll
      footer={
        <>
          <Button label="Get started" onPress={() => router.push('/age')} />
          <Text variant="caption" tone="tertiary" style={{ textAlign: 'center' }}>
            {brand.appStoreSubtitle}
          </Text>
        </>
      }
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingVertical: 48 }}>
        <Orb size={200} />
        <Text variant="display" style={{ textAlign: 'center' }} accessibilityRole="header">
          {brand.tagline}
        </Text>
        <Text variant="body" tone="secondary" style={{ textAlign: 'center' }}>
          {brand.supportingLine}
        </Text>
      </View>
    </Scaffold>
  );
}
