import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { SPORTS, colors as tokenColors } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { Orb } from '@/components/Orb';
import { Screen } from '@/components/Screen';
import { Segmented } from '@/components/Segmented';
import { SelectSheet } from '@/components/SelectSheet';
import { Skeleton } from '@/components/Skeleton';
import { Slider } from '@/components/Slider';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { useToast } from '@/components/Toast';
import { useTheme } from '@/theme/theme';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 12, marginTop: 20 }}>
      <Text variant="title2" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

/**
 * Component gallery (SPEC §15 M1). Every component is shown in its states so the founder can check them
 * on the iPhone at the largest Dynamic Type size, with VoiceOver and with Reduce Motion.
 */
export default function Gallery() {
  const { colors, scheme } = useTheme();
  const toast = useToast();
  const sheet = useRef<BottomSheetModal>(null);
  const [chip, setChip] = useState('ambient_warm');
  const [seg, setSeg] = useState<'first_person' | 'third_person'>('first_person');
  const [sport, setSport] = useState<string | null>(null);
  const [vivid, setVivid] = useState(3);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');

  const swatches = Object.entries(tokenColors[scheme]);

  return (
    <Screen>
      <Text variant="callout" tone="secondary">
        Scheme: {scheme}. Check each section at the largest Dynamic Type size, with VoiceOver on, and with
        Reduce Motion on.
      </Text>

      <Section title="Typography">
        <Text variant="display">Display</Text>
        <Text variant="title1">Title one</Text>
        <Text variant="title2">Title two</Text>
        <Text variant="headline">Headline</Text>
        <Text variant="body">Body text for chat and long copy.</Text>
        <Text variant="callout" tone="secondary">
          Callout, secondary
        </Text>
        <Text variant="caption" tone="tertiary">
          Caption label
        </Text>
        <Text variant="body" tabular>
          Tabular numbers 0123456789
        </Text>
      </Section>

      <Section title="Colour tokens">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {swatches.map(([name, hex]) => (
            <View key={name} style={{ width: 96, gap: 4 }}>
              <View
                style={{
                  height: 40,
                  borderRadius: 8,
                  backgroundColor: hex,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              />
              <Text variant="caption" tone="secondary">
                {name}
              </Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Buttons">
        <Button label="Primary" />
        <Button label="Secondary" kind="secondary" />
        <Button label="Text button" kind="text" />
        <Button label="Disabled" disabled />
        <Button
          label={loading ? 'Loading' : 'Tap to load for 2 seconds'}
          loading={loading}
          onPress={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 2000);
          }}
        />
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <IconButton symbol="play.fill" label="Play" />
          <IconButton symbol="gobackward.15" label="Back 15 seconds" />
          <IconButton symbol="goforward.15" label="Forward 15 seconds" />
          <IconButton symbol="xmark" label="Disabled close" disabled />
        </View>
      </Section>

      <Section title="Chips">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {['ambient_warm', 'ambient_airy', 'low_drone', 'pulse'].map((s) => (
            <Chip key={s} label={s.replace('_', ' ')} selected={chip === s} onPress={() => setChip(s)} />
          ))}
        </View>
      </Section>

      <Section title="Text input">
        <TextField
          label="Event name"
          placeholder="Fictional City Marathon"
          value={name}
          onChangeText={setName}
        />
        <TextField label="With error" value="abc" error="Enter a name with at least 4 characters." />
      </Section>

      <Section title="Segmented control">
        <Segmented
          options={[
            { value: 'first_person', label: 'First person' },
            { value: 'third_person', label: 'Third person' },
          ]}
          value={seg}
          onChange={setSeg}
        />
      </Section>

      <Section title="Slider">
        <Slider label="Vividness" value={vivid} onChange={setVivid} />
      </Section>

      <Section title="Select (bottom sheet)">
        <Button
          kind="secondary"
          label={sport ? `Sport: ${SPORTS.find((s) => s.id === sport)?.label}` : 'Choose a sport'}
          onPress={() => sheet.current?.present()}
        />
        <SelectSheet
          ref={sheet}
          title="Sport"
          searchable
          value={sport}
          onSelect={setSport}
          options={SPORTS.map((s) => ({ value: s.id, label: s.label }))}
        />
      </Section>

      <Section title="Cards">
        <Card>
          <Text variant="headline">Default card</Text>
          <Text variant="callout" tone="secondary">
            Radius 24, surface, padding 20.
          </Text>
        </Card>
        <Card
          context="training"
          onPress={() => toast('Training card pressed')}
          accessibilityLabel="Training card"
        >
          <Text variant="headline">Training context, pressable</Text>
        </Card>
        <Card context="night_before">
          <Text variant="headline">Night before context</Text>
        </Card>
        <Card context="primer">
          <Text variant="headline">Primer context</Text>
        </Card>
      </Section>

      <Section title="Orb">
        <View style={{ flexDirection: 'row', gap: 24, alignItems: 'center' }}>
          <Orb size={120} />
          <Orb size={120} breathing />
        </View>
        <Text variant="callout" tone="secondary">
          Left: ambient. Right: breathing guide (4 s in, 2 s hold, 6 s out). Both are static under Reduce
          Motion.
        </Text>
      </Section>

      <Section title="Toast, skeleton, empty state">
        <Button kind="secondary" label="Show toast" onPress={() => toast('Saved')} />
        <Skeleton height={20} />
        <Skeleton width="60%" height={20} />
        <EmptyState
          message="No sessions yet. Create your first one."
          actionLabel="Create a session"
          onAction={() => toast('Not built yet')}
        />
      </Section>
    </Screen>
  );
}
