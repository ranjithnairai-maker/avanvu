import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, View } from 'react-native';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { useSessions } from '@/lib/api/queries';
import { readIndex, removeSession } from '@/lib/native/sessionFiles';
import { offlineBadge } from '@/lib/offline/sync';
import { CONTEXT_LABEL } from '@/lib/sessions';

const FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'training', label: 'Training' },
  { value: 'night_before', label: 'Night before' },
  { value: 'primer', label: 'Primer' },
] as const;

const BADGE = {
  ready_offline: 'Ready offline',
  downloading: 'Downloading',
  online_only: 'Online only',
  preparing: 'Preparing',
} as const;

export default function Library() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>(undefined);
  const q = useSessions(filter);
  const local = readIndex();

  const remove = (id: string) =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['Delete session', 'Cancel'],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
        message: 'This deletes the script and audio. The session stays counted in your allowance.',
      },
      async (i) => {
        if (i !== 0) return;
        try {
          await api.del(`/v1/sessions/${id}`);
          removeSession(id);
          void qc.invalidateQueries({ queryKey: ['sessions'] });
        } catch {
          toast("We couldn't delete that. Try again.");
        }
      },
    );

  return (
    <Scaffold title="Library">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {FILTERS.map((f) => (
          <Chip
            key={f.label}
            label={f.label}
            selected={filter === f.value}
            onPress={() => setFilter(f.value)}
          />
        ))}
      </View>
      {q.isPending ? [0, 1, 2].map((i) => <Skeleton key={i} height={88} />) : null}
      {q.isError ? (
        <Notice kind="info">We couldn't refresh your library. Downloaded sessions still play.</Notice>
      ) : null}
      {q.data && q.data.sessions.length === 0 ? (
        <EmptyState
          message="Your sessions will appear here."
          actionLabel="Go to Home"
          onAction={() => router.push('/')}
        />
      ) : null}
      {q.data?.sessions.map((s) => {
        const badge = offlineBadge(
          { id: s.id, state: s.state, sha256: s.sha256 ?? null, bytes: s.bytes ?? null },
          local.find((f) => f.id === s.id),
          new Set(),
        );
        return (
          <Card
            key={s.id}
            context={s.context}
            onPress={() => router.push({ pathname: '/session/[id]', params: { id: s.id } })}
            accessibilityLabel={`${CONTEXT_LABEL[s.context]}, ${s.length_min} minutes, ${BADGE[badge]}. Double tap to open. Actions available.`}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="headline">{CONTEXT_LABEL[s.context]}</Text>
                <Text variant="callout" tone="secondary">
                  {s.length_min} min ·{' '}
                  {new Date(s.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text variant="caption" tone={badge === 'ready_offline' ? 'success' : 'tertiary'}>
                  {s.status === 'failed' ? 'Failed' : BADGE[badge]}
                </Text>
                <Text
                  variant="callout"
                  tone="accent"
                  onPress={() => remove(s.id)}
                  accessibilityRole="button"
                  accessibilityLabel="More actions"
                >
                  Delete
                </Text>
              </View>
            </View>
          </Card>
        );
      })}
    </Scaffold>
  );
}
