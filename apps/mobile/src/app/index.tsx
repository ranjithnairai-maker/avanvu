import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Orb } from '@/components/Orb';
import { Scaffold } from '@/components/Scaffold';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { useAuth } from '@/lib/auth/store';
import { useMe } from '@/lib/api/queries';
import { ApiError } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Launch gate: decides where the athlete goes. Signed out -> Welcome. Signed in -> the right place in the first-run
 * journey (sport -> event -> interview -> summary -> delivery) or Home once a confirmed profile exists.
 */
export default function Gate() {
  const status = useAuth((s) => s.status);
  const me = useMe();
  const qc = useQueryClient();

  if (status === 'loading') return <Loading />;
  if (status === 'signedOut') return <Redirect href="/welcome" />;
  if (me.isPending) return <Loading />;
  if (me.isError) {
    const offline = me.error instanceof ApiError && me.error.code === 'NETWORK';
    return (
      <Scaffold
        title={offline ? "You're offline" : 'Something went wrong'}
        footer={<Button label="Try again" onPress={() => qc.invalidateQueries({ queryKey: ['me'] })} />}
      >
        <Notice kind={offline ? 'info' : 'error'}>
          {offline
            ? 'Downloaded sessions still play. Connect to continue setting up.'
            : "We couldn't load your account. Check your connection and try again."}
        </Notice>
        <Button label="Downloaded sessions" kind="secondary" onPress={() => undefined} />
      </Scaffold>
    );
  }
  const d = me.data;
  if (!d.user.age_assured) return <Redirect href="/age" />;
  if (d.has_profile) return <Redirect href="/(tabs)/home" />;
  if (d.active_intake) {
    return d.active_intake.state === 'READY_FOR_SUMMARY' || d.active_intake.state === 'SUMMARY_CONFIRMED' ? (
      <Redirect href={{ pathname: '/intake/summary', params: { id: d.active_intake.id } }} />
    ) : (
      <Redirect href={{ pathname: '/intake/chat', params: { id: d.active_intake.id } }} />
    );
  }
  if (d.upcoming_event)
    return <Redirect href={{ pathname: '/intake/chat', params: { event: d.upcoming_event.id } }} />;
  return <Redirect href="/sport" />;
}

function Loading() {
  return (
    <Scaffold>
      <View style={{ alignItems: 'center', gap: 24, paddingTop: 80 }}>
        <Orb size={120} />
        <Text variant="callout" tone="secondary">
          One moment
        </Text>
        <Skeleton width="60%" />
      </View>
    </Scaffold>
  );
}
