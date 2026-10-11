import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Slider } from '@/components/Slider';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { api, ApiError } from '@/lib/api';

type Cue = 'yes' | 'somewhat' | 'no' | 'not_used';
const CUES: { value: Cue; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'somewhat', label: 'Somewhat' },
  { value: 'no', label: 'No' },
  { value: 'not_used', label: "Didn't use it" },
];

interface Proposal {
  id: string;
  op: string;
  path: string;
  item_id: string;
  value: string;
  default_checked: boolean;
}
interface Proposed {
  state: 'proposed';
  id: string;
  summary: string;
  proposals: Proposal[];
}

/** Debrief (SPEC §8.4): five questions, then a checklist of proposed profile changes; nothing applies until confirmed. */
export default function Debrief() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [overall, setOverall] = useState(3);
  const [wentWell, setWentWell] = useState('');
  const [harder, setHarder] = useState('');
  const [cue, setCue] = useState<Cue>('somewhat');
  const [nextTime, setNextTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clarify, setClarify] = useState<string | null>(null);
  const [proposed, setProposed] = useState<Proposed | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const key = useRef(api.newKey());

  const submit = async () => {
    setBusy(true);
    setError(null);
    setClarify(null);
    try {
      const body = {
        event_id: eventId,
        overall,
        cue_helped: cue,
        ...(wentWell.trim() ? { went_well: wentWell.trim() } : {}),
        ...(harder.trim() ? { harder: harder.trim() } : {}),
        ...(nextTime.trim() ? { next_time: nextTime.trim() } : {}),
      };
      const r = await api.post<Proposed | { state: 'clarify'; message: string }>('/v1/debriefs', body, {
        idempotencyKey: key.current,
      });
      if (r.state === 'clarify') {
        setClarify(r.message);
        key.current = api.newKey();
        return;
      }
      setProposed(r);
      setAccepted(new Set(r.proposals.filter((p) => p.default_checked).map((p) => p.id)));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SAFETY_INTERRUPTED') {
        router.replace('/safety');
        return;
      }
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      key.current = api.newKey();
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!proposed) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/v1/debriefs/${proposed.id}/confirm`,
        { accepted_item_ids: [...accepted] },
        { idempotencyKey: api.newKey() },
      );
      await qc.invalidateQueries();
      router.replace('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setAccepted((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (proposed) {
    return (
      <Scaffold
        title="What we'll remember"
        subtitle={proposed.summary}
        footer={
          <>
            <Button
              label={accepted.size === 0 ? 'Save without changes' : 'Apply selected changes'}
              loading={busy}
              onPress={confirm}
            />
          </>
        }
      >
        {proposed.proposals.length === 0 ? (
          <Text variant="body" tone="secondary">
            No changes to your profile this time.
          </Text>
        ) : null}
        {proposed.proposals.map((p) => (
          <Chip
            key={p.id}
            label={`${p.op === 'remove' ? 'Remove' : p.op === 'add' ? 'Add' : 'Change'}: ${p.value || p.path}`}
            selected={accepted.has(p.id)}
            onPress={() => toggle(p.id)}
          />
        ))}
        {error ? <Notice kind="error">{error}</Notice> : null}
      </Scaffold>
    );
  }

  return (
    <Scaffold
      title="How did it go?"
      subtitle="Three minutes to capture what you learned. Skip anything you like."
      footer={<Button label="Continue" loading={busy} onPress={submit} />}
    >
      <Slider label="Overall, how did it feel?" value={overall} onChange={setOverall} />
      <TextField
        label="What went well?"
        value={wentWell}
        onChangeText={(t) => setWentWell(t.slice(0, 280))}
        multiline
      />
      <TextField
        label="What was harder than expected?"
        value={harder}
        onChangeText={(t) => setHarder(t.slice(0, 280))}
        multiline
      />
      <Text variant="caption" tone="secondary" accessibilityRole="header">
        Did your cue help?
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {CUES.map((c) => (
          <Chip key={c.value} label={c.label} selected={cue === c.value} onPress={() => setCue(c.value)} />
        ))}
      </View>
      <TextField
        label="Anything to change for next time?"
        value={nextTime}
        onChangeText={(t) => setNextTime(t.slice(0, 280))}
        multiline
      />
      {clarify ? <Notice kind="info">{clarify}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
