import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { SPORTS } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Scaffold } from '@/components/Scaffold';
import { SelectSheet } from '@/components/SelectSheet';
import { Text } from '@/components/Text';
import { useOnboarding } from '@/lib/onboarding';

const OTHER = '__other_endurance__';
const options = [
  ...SPORTS.filter((s) => s.id !== 'custom_endurance').map((s) => ({ value: s.id, label: s.label })),
  { value: OTHER, label: 'Other endurance event' },
];

/** Scope gate (SPEC §2.2): only supported sports reach the interview; everything else sees the waitlist. */
export default function Sport() {
  const router = useRouter();
  const sheet = useRef<BottomSheetModal>(null);
  const setSport = useOnboarding((s) => s.setSport);

  return (
    <Scaffold
      title="What are you training for?"
      subtitle="Pick your sport. Avanvu builds your sessions around it."
      footer={
        <>
          <Button label="Choose your sport" onPress={() => sheet.current?.present()} />
          <Button label="My sport isn't listed" kind="text" onPress={() => router.push('/waitlist')} />
        </>
      }
    >
      <Text variant="callout" tone="tertiary">
        Running, cycling, swimming, triathlon, rowing, paddling and more, plus soccer, basketball, cricket,
        baseball, golf, tennis and badminton.
      </Text>
      <SelectSheet
        ref={sheet}
        title="Sport"
        searchable
        value={null}
        options={options}
        onSelect={(value) => {
          if (value === OTHER) router.push('/custom-endurance');
          else {
            setSport(value);
            router.push('/event');
          }
        }}
      />
    </Scaffold>
  );
}
