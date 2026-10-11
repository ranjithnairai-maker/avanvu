import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { radius, type AthleteProfile, type ProfileUpdate } from '@avanvu/core';
import { Button } from '@/components/Button';
import { EditSheet } from '@/components/EditSheet';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { api, ApiError } from '@/lib/api';
import {
  buildSummary,
  editIsValid,
  editToUpdates,
  removeUpdate,
  type SummaryRow,
} from '@/lib/intake/summaryModel';
import { useTheme } from '@/theme/theme';

interface View_ {
  id: string;
  event_id: string;
  state: string;
  revision: number;
  profile: AthleteProfile;
  minimum_missing: string[];
}

/** "Here's your event as I understand it." Every item is editable; Continue unlocks once the essentials are in. */
export default function Summary() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const [view, setView] = useState<View_ | null>(null);
  const [eventName, setEventName] = useState('Your event');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<SummaryRow | null>(null);
  const sheet = useRef<BottomSheetModal>(null);
  const confirmKey = useRef(api.newKey());

  const load = useCallback(async () => {
    try {
      const v = await api.get<View_>(`/v1/intake/conversations/${id}`);
      setView(v);
      api
        .get<{ name: string }>(`/v1/events/${v.event_id}`)
        .then((e) => setEventName(e.name))
        .catch(() => undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  const submit = async (updates: ProfileUpdate[]) => {
    if (!view || updates.length === 0) return;
    setError(null);
    try {
      const next = await api.post<View_>(`/v1/intake/conversations/${id}/edits`, {
        expected_revision: view.revision,
        updates,
      });
      setView(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      if (e instanceof ApiError && e.code === 'PROFILE_REVISION_CONFLICT') await load();
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/intake/conversations/${id}/confirm`, undefined, {
        idempotencyKey: confirmKey.current,
      });
      router.replace('/intake/delivery');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      confirmKey.current = api.newKey();
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <Scaffold title="Your event, as I understand it">
        {error ? (
          <Notice kind="error">{error}</Notice>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} height={72} />)
        )}
      </Scaffold>
    );
  }

  const sections = buildSummary(view.profile, eventName, view.minimum_missing);
  const ready = view.minimum_missing.length === 0;
  const open = (row: SummaryRow) => {
    if (row.fields.length === 0) return;
    setEditing(row);
    setTimeout(() => sheet.current?.present(), 0);
  };

  return (
    <Scaffold
      title="Here's your event as I understand it"
      subtitle="Tap anything to change it."
      footer={
        <>
          {!ready ? (
            <Text variant="callout" tone="secondary" style={{ textAlign: 'center' }}>
              Add the highlighted items to continue.
            </Text>
          ) : null}
          <Button label="Continue" loading={busy} disabled={!ready} onPress={confirm} />
        </>
      }
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      {sections.map((s) => (
        <View key={s.title} style={{ gap: 8, marginTop: 12 }}>
          <Text variant="caption" tone="secondary" accessibilityRole="header">
            {s.title}
          </Text>
          {s.rows.map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              accessibilityLabel={r.add ? r.display : `${s.title}: ${r.display}. Edit`}
              disabled={r.fields.length === 0}
              onPress={() => open(r)}
              style={{
                padding: 16,
                minHeight: 56,
                borderRadius: radius.input,
                backgroundColor: colors.surface,
                borderWidth: r.add ? 1.5 : 1,
                borderColor: r.add ? colors.accent : colors.border,
              }}
            >
              <Text variant={r.large ? 'title2' : 'body'} tone={r.add ? 'accent' : 'primary'}>
                {r.large ? `“${r.display}”` : r.display}
              </Text>
            </Pressable>
          ))}
          {s.canAdd?.map((a) => (
            <Button
              key={a.path}
              kind="text"
              label={a.label}
              onPress={() =>
                open({
                  id: `new:${a.path}`,
                  path: a.path,
                  kind: a.kind,
                  display: '',
                  fields: [
                    { key: 'label', label: 'Name this moment', value: '', max: 60 },
                    { key: 'description', label: 'What happens', value: '', max: 300, multiline: true },
                  ],
                })
              }
            />
          ))}
        </View>
      ))}
      <EditSheet
        ref={sheet}
        title={editing?.add || editing?.id.startsWith('new:') ? 'Add' : 'Edit'}
        fields={editing?.fields ?? []}
        canSave={(v) => (editing ? editIsValid(editing, v) : false)}
        onSave={(v) => editing && void submit(editToUpdates(editing, v))}
        {...(editing?.itemId ? { onRemove: () => editing && void submit(removeUpdate(editing)) } : {})}
      />
    </Scaffold>
  );
}
