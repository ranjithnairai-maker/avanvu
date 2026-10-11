import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import {
  CUSTOM_ENDURANCE_LABEL_MAX,
  CUSTOM_ENDURANCE_QUESTIONS,
  isCustomEnduranceEligible,
} from '@avanvu/core';
import { Button } from '@/components/Button';
import { Scaffold } from '@/components/Scaffold';
import { Segmented } from '@/components/Segmented';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { useOnboarding } from '@/lib/onboarding';

type Answer = 'yes' | 'no' | null;

/** Eligibility checklist for an "Other endurance event" (SPEC §2.3). The server decides again; this is the UI. */
export default function CustomEndurance() {
  const router = useRouter();
  const setSport = useOnboarding((s) => s.setSport);
  const [label, setLabel] = useState('');
  const [answers, setAnswers] = useState<Answer[]>(CUSTOM_ENDURANCE_QUESTIONS.map(() => null));

  const complete = label.trim().length > 0 && answers.every((a) => a !== null);
  const next = () => {
    const bools = answers.map((a) => a === 'yes');
    if (isCustomEnduranceEligible(bools)) {
      setSport('custom_endurance', label.trim(), bools);
      router.push('/event');
    } else {
      router.push({ pathname: '/waitlist', params: { label: label.trim() } });
    }
  };

  return (
    <Scaffold
      title="Tell us about your event"
      subtitle="A few quick questions to check we can build good sessions for it."
      footer={<Button label="Continue" disabled={!complete} onPress={next} />}
    >
      <TextField
        label="Your event, in your words"
        placeholder="For example, a 24 hour relay"
        value={label}
        onChangeText={(t) => setLabel(t.slice(0, CUSTOM_ENDURANCE_LABEL_MAX))}
        maxLength={CUSTOM_ENDURANCE_LABEL_MAX}
      />
      {CUSTOM_ENDURANCE_QUESTIONS.map((q, i) => (
        <View key={q} style={{ gap: 8, marginTop: 8 }}>
          <Text variant="body">{q}</Text>
          <Segmented
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
            value={answers[i] ?? null}
            onChange={(v) => setAnswers((prev) => prev.map((x, n) => (n === i ? v : x)))}
          />
        </View>
      ))}
    </Scaffold>
  );
}
