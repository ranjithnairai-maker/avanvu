import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Notice } from '@/components/Notice';
import { Row } from '@/components/Row';
import { Scaffold } from '@/components/Scaffold';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { useMe, useProfile, useProgram, type ProgramItemDto } from '@/lib/api/queries';
import { needsOfflineAttention } from '@/lib/offline/sync';
import { readIndex, syncOfflineContent } from '@/lib/native/sessionFiles';
import { scheduleEventReminders } from '@/lib/native/notifications';
import { CONTEXT_LABEL, startSession } from '@/lib/sessions';

const greeting = (d = new Date()) =>
  d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening';
const daysUntil = (iso: string) =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
const fmtDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

export default function Home() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const event = me.data?.upcoming_event ?? null;
  const program = useProgram(event?.program_id);
  const profile = useProfile();
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const keys = useRef(new Map<string, string>());

  // Foreground sync and reminders (SPEC §6.6, §9.6): on focus, on returning to the app, and after event changes.
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['me'] });
    void syncOfflineContent().catch(() => undefined);
  }, [qc]);
  useFocusEffect(refresh);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);
  useEffect(() => {
    if (event)
      void scheduleEventReminders({
        id: event.id,
        starts_local: event.starts_local,
        time_zone: event.time_zone,
      }).catch(() => undefined);
  }, [event?.id, event?.starts_local, event?.time_zone]);

  if (me.isPending) {
    return (
      <Scaffold title="Home">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={96} />
        ))}
      </Scaffold>
    );
  }
  if (me.isError || !me.data) {
    return (
      <Scaffold title="Home" footer={<Button label="Try again" onPress={refresh} />}>
        <Notice kind="info">We couldn't refresh. Downloaded sessions still play from your Library.</Notice>
      </Scaffold>
    );
  }
  const d = me.data;
  const pro = d.entitlement?.active === true;
  const items = program.data?.items ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const nextTraining =
    items.find(
      (i) => i.kind === 'training' && i.state === 'planned' && !i.locked && i.target_date <= today,
    ) ?? items.find((i) => i.kind === 'training' && i.state === 'planned' && !i.locked);

  const begin = async (item: ProgramItemDto | null, context: 'training' | 'night_before' | 'primer') => {
    const id = item?.id ?? `adhoc-${context}`;
    setBusyItem(id);
    if (!keys.current.has(id)) keys.current.set(id, api.newKey());
    const length =
      (context === 'training'
        ? profile.data?.profile.preferences.training_length_min
        : context === 'primer'
          ? profile.data?.profile.preferences.primer_length_min
          : 15) ?? 15;
    const r = await startSession(
      qc,
      { program_item_id: item?.id ?? null, context, length_min: length as 3 | 5 | 10 | 15 },
      keys.current.get(id) as string,
    );
    setBusyItem(null);
    if (r.ok) {
      keys.current.delete(id);
      router.push({ pathname: '/session/[id]', params: { id: r.session.id } });
    } else if (r.reason === 'paywall') router.push('/paywall');
    else {
      keys.current.delete(id);
      toast(r.message);
    }
  };

  const open = (item: ProgramItemDto) => {
    if (item.session_id) router.push({ pathname: '/session/[id]', params: { id: item.session_id } });
    else if (item.locked) router.push('/paywall');
    else if (item.kind === 'training') void begin(item, 'training');
    else if (item.kind === 'debrief' && event)
      router.push({ pathname: '/debrief/[eventId]', params: { eventId: event.id } });
  };

  const attention =
    event && program.data
      ? needsOfflineAttention(
          new Date(event.starts_at),
          new Date(),
          items
            .filter((i) => i.kind === 'night_before' || i.kind === 'primer')
            .map((i) => ({ id: i.session_id ?? i.id, state: i.state })),
          readIndex(),
        )
      : false;

  return (
    <Scaffold
      title={greeting()}
      footer={
        nextTraining ? (
          <Button
            label="Start today's session"
            loading={busyItem === nextTraining.id}
            onPress={() => void begin(nextTraining, 'training')}
          />
        ) : event ? undefined : (
          <Button label="Set up an event" onPress={() => router.push('/sport')} />
        )
      }
    >
      {d.pending_debrief ? (
        <Card
          context="primer"
          onPress={() =>
            router.push({
              pathname: '/debrief/[eventId]',
              params: { eventId: (d.pending_debrief as { id: string }).id },
            })
          }
          accessibilityLabel="How did it go? Capture what you learned"
        >
          <Text variant="title2">How did it go?</Text>
          <Text variant="callout" tone="secondary">
            Three minutes to capture what you learned from {d.pending_debrief.name}.
          </Text>
        </Card>
      ) : null}

      {event ? (
        <Card
          context="training"
          onPress={() => router.push({ pathname: '/event/[id]/edit', params: { id: event.id } })}
          accessibilityLabel={`${event.name}. Edit event`}
        >
          <Text variant="caption" tone="secondary">
            {event.name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text variant="display" tabular>
              {daysUntil(event.starts_at)}
            </Text>
            <Text variant="headline" tone="secondary">
              {daysUntil(event.starts_at) === 1 ? 'day to go' : 'days to go'}
            </Text>
          </View>
        </Card>
      ) : (
        <EmptyState
          message="Set up your next event and Avanvu builds your program."
          actionLabel="Set up an event"
          onAction={() => router.push('/sport')}
        />
      )}

      {attention ? (
        <Card
          onPress={() => {
            setSyncing(true);
            syncOfflineContent().finally(() => setSyncing(false));
          }}
          accessibilityLabel="Save your race-day sessions for offline"
        >
          <Text variant="headline">{syncing ? 'Saving…' : 'Save for offline'}</Text>
          <Text variant="callout" tone="secondary">
            Make sure your race-day sessions are on this phone before you travel.
          </Text>
        </Card>
      ) : null}

      {program.data ? (
        <View style={{ gap: 8, marginTop: 8 }}>
          <Text variant="caption" tone="secondary" accessibilityRole="header">
            Your program
          </Text>
          {items
            .filter((i) => i.kind !== 'debrief')
            .map((i) => {
              const done = i.state === 'ready';
              const isToday = i.target_date === today;
              const status = done
                ? 'Ready'
                : i.state === 'generating'
                  ? 'Preparing'
                  : i.locked
                    ? 'Locked'
                    : isToday
                      ? 'Today'
                      : i.state === 'locked'
                        ? 'Needs attention'
                        : 'Upcoming';
              return (
                <Row
                  key={i.id}
                  title={CONTEXT_LABEL[i.kind as 'training' | 'night_before' | 'primer']}
                  subtitle={`${fmtDate(i.target_date)}${i.kind === 'night_before' || i.kind === 'primer' ? ' · generated 3 days ahead' : ''}`}
                  accessory={
                    <Text variant="callout" tone={done ? 'success' : i.locked ? 'tertiary' : 'secondary'}>
                      {status}
                    </Text>
                  }
                  onPress={() => open(i)}
                />
              );
            })}
        </View>
      ) : null}

      {!pro && d.allowance.free_training === 0 ? (
        <Card onPress={() => router.push('/paywall')} accessibilityLabel="See what Avanvu Pro includes">
          <Text variant="headline">Keep building your program</Text>
          <Text variant="callout" tone="secondary">
            Pro includes 12 new sessions a month, every context and length, and your night-before and primer
            sessions.
          </Text>
        </Card>
      ) : null}

      {pro ? (
        <Button
          kind="secondary"
          label="Create a personalized primer"
          loading={busyItem === 'adhoc-primer'}
          onPress={() => void begin(null, 'primer')}
        />
      ) : null}
      {d.allowance.pro ? (
        <Text variant="caption" tone="tertiary" tabular>
          {d.allowance.pro.available_for_on_demand} sessions available
          {d.allowance.pro.held_for_events > 0
            ? `, ${d.allowance.pro.held_for_events} held for race day`
            : ''}
        </Text>
      ) : null}
    </Scaffold>
  );
}
