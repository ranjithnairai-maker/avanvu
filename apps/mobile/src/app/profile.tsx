import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { radius, type ProfileUpdate } from '@avanvu/core';
import { EditSheet } from '@/components/EditSheet';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { api, ApiError } from '@/lib/api';
import { useMe, useProfile } from '@/lib/api/queries';
import {
  buildSummary,
  editIsValid,
  editToUpdates,
  removeUpdate,
  type SummaryRow,
} from '@/lib/intake/summaryModel';
import { useTheme } from '@/theme/theme';

/** The confirmed profile, editable (SPEC §8.2 You). Each change saves a new immutable version after validation. */
export default function ProfileScreen() {
  const { colors } = useTheme();
  const qc = useQueryClient();
  const profile = useProfile();
  const me = useMe();
  const [editing, setEditing] = useState<SummaryRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<BottomSheetModal>(null);

  const save = async (updates: ProfileUpdate[]) => {
    if (!profile.data || updates.length === 0) return;
    setError(null);
    try {
      await api.patch('/v1/profile', { base_version: profile.data.version, updates });
      await qc.invalidateQueries({ queryKey: ['profile'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      if (e instanceof ApiError && e.code === 'PROFILE_REVISION_CONFLICT')
        await qc.invalidateQueries({ queryKey: ['profile'] });
    }
  };

  if (!profile.data) {
    return (
      <Scaffold title="My profile">
        {profile.isError ? (
          <Notice kind="error">We couldn't load your profile. Check your connection.</Notice>
        ) : (
          [0, 1, 2].map((i) => <Skeleton key={i} height={72} />)
        )}
      </Scaffold>
    );
  }
  const sections = buildSummary(profile.data.profile, me.data?.upcoming_event?.name ?? 'Your event', []);
  return (
    <Scaffold
      title="My profile"
      subtitle="Changes apply to your next new session. Existing sessions aren't rewritten."
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
              accessibilityLabel={`${s.title}: ${r.display}. Edit`}
              disabled={r.fields.length === 0}
              onPress={() => {
                setEditing(r);
                setTimeout(() => sheet.current?.present(), 0);
              }}
              style={{
                padding: 16,
                minHeight: 56,
                borderRadius: radius.input,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text variant={r.large ? 'title2' : 'body'}>{r.large ? `“${r.display}”` : r.display}</Text>
            </Pressable>
          ))}
        </View>
      ))}
      <EditSheet
        ref={sheet}
        title="Edit"
        fields={editing?.fields ?? []}
        canSave={(v) => (editing ? editIsValid(editing, v) : false)}
        onSave={(v) => editing && void save(editToUpdates(editing, v))}
        {...(editing?.itemId ? { onRemove: () => editing && void save(removeUpdate(editing)) } : {})}
      />
    </Scaffold>
  );
}
