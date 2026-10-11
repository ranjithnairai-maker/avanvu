import { getLocales } from 'expo-localization';
import { useRouter } from 'expo-router';
import { Linking } from 'react-native';
import { crisisCardFor, territoryFromStorefront, type CrisisResource } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';

const open = (r: CrisisResource) => {
  const url = r.kind === 'call' ? `tel:${r.value}` : r.kind === 'text' ? `sms:${r.value}` : r.value;
  void Linking.openURL(url);
};

/**
 * Crisis screen (SPEC §12.2): calm, full-screen, resources for the athlete's territory from reviewed configuration.
 * It never labels or diagnoses, and the only way forward is the resource buttons or leaving to Home. The copy and
 * resources are seed text pending the content and safety reviewer (D-29, D-30).
 */
export default function Safety() {
  const router = useRouter();
  const territory = territoryFromStorefront(getLocales()[0]?.regionCode);
  const card = crisisCardFor(territory);
  return (
    <Scaffold
      title={card.title}
      subtitle={card.body}
      footer={<Button label={card.leaveLabel} kind="secondary" onPress={() => router.replace('/')} />}
    >
      {card.resources.map((r) => (
        <Button
          key={r.id}
          label={r.label}
          onPress={() => open(r)}
          accessibilityHint="Opens your phone to get help now"
        />
      ))}
      <Text variant="callout" tone="tertiary" style={{ marginTop: 8 }}>
        You can come back to Avanvu whenever you like. Nothing you said has been saved to your profile.
      </Text>
    </Scaffold>
  );
}
