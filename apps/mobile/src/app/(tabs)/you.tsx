import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { Row } from '@/components/Row';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { useMe } from '@/lib/api/queries';
import { config } from '@/lib/config';
import { removeAllSessions, readIndex } from '@/lib/native/sessionFiles';
import { logOutPurchases, restore } from '@/lib/native/purchases';
import { notificationPermission, type PermissionState } from '@/lib/native/notifications';
import { signOut } from '@/lib/auth/signIn';
import { storageSummary } from '@/lib/offline/sync';
import { useToast } from '@/components/Toast';

const mb = (b: number) => `${(b / 1_000_000).toFixed(0)} MB`;

/** You (SPEC §8.2): profile, events, delivery, subscription, notifications, offline storage, privacy, help. */
export default function You() {
  const router = useRouter();
  const me = useMe();
  const toast = useToast();
  const [perm, setPerm] = useState<PermissionState>('undetermined');
  const [storage, setStorage] = useState(storageSummary(readIndex()));
  useEffect(
    () =>
      void notificationPermission()
        .then(setPerm)
        .catch(() => undefined),
    [],
  );

  const pro = me.data?.entitlement?.active === true;
  const allowance = me.data?.allowance;

  return (
    <Scaffold title="You">
      <Section title="Profile and events">
        <Row
          title="My profile"
          subtitle="What Avanvu knows about your event"
          onPress={() => router.push('/profile')}
        />
        {me.data?.upcoming_event ? (
          <Row
            title={me.data.upcoming_event.name}
            subtitle="Edit your event"
            onPress={() =>
              router.push({
                pathname: '/event/[id]/edit',
                params: { id: (me.data?.upcoming_event as { id: string }).id },
              })
            }
          />
        ) : (
          <Row title="Add an event" onPress={() => router.push('/sport')} />
        )}
        <Row
          title="Delivery"
          subtitle="Voice, music, perspective and lengths"
          onPress={() => router.push({ pathname: '/intake/delivery', params: { mode: 'settings' } })}
        />
      </Section>

      <Section title="Subscription">
        <Row
          title={pro ? 'Avanvu Pro' : 'Free plan'}
          subtitle={
            pro && allowance?.pro
              ? `${allowance.pro.available_for_on_demand} sessions available${allowance.pro.held_for_events ? `, ${allowance.pro.held_for_events} held for race day` : ''}`
              : `${allowance?.free_training ?? 0} free training session left`
          }
          onPress={() => router.push('/paywall')}
        />
        <Row
          title="Restore purchases"
          onPress={async () =>
            toast(
              (await restore().catch(() => ({ found: false }))).found
                ? 'Purchases restored'
                : 'No purchases found',
            )
          }
        />
        <Row
          title="Manage subscription"
          onPress={() => Linking.openURL('https://apps.apple.com/account/subscriptions')}
        />
      </Section>

      <Section title="Notifications">
        <Row
          title="Reminders"
          subtitle={perm === 'granted' ? 'On' : perm === 'denied' ? 'Off in Settings' : 'Off'}
          onPress={() => router.push('/notifications-intro')}
        />
      </Section>

      <Section title="Offline storage">
        <Row
          title="Downloaded sessions"
          subtitle={`${storage.files} sessions, ${mb(storage.bytes)}`}
          onPress={() => {
            removeAllSessions();
            setStorage(storageSummary(readIndex()));
            toast('Downloads removed');
          }}
          accessibilityHint="Removes downloaded sessions from this phone"
        />
      </Section>

      <Section title="Privacy and safety">
        <Row title="Export my data" onPress={() => router.push('/account/export')} />
        <Row title="Delete my account" destructive onPress={() => router.push('/account/delete')} />
        <Row
          title="Safety resources"
          subtitle="If you need support right now"
          onPress={() => router.push('/safety')}
        />
      </Section>

      <Section title="Help">
        <Row title="Contact support" onPress={() => Linking.openURL(config.supportUrl)} />
        <Row title="Privacy Policy" onPress={() => Linking.openURL(config.privacyUrl)} />
        <Row title="Terms of Use" onPress={() => Linking.openURL(config.termsUrl)} />
        <Row
          title="About"
          subtitle={`Avanvu ${Constants.expoConfig?.version ?? ''}. Mental rehearsal for performance preparation. Not therapy or medical care.`}
        />
        <Row
          title="Sign out"
          onPress={async () => {
            await logOutPurchases();
            await signOut();
            router.replace('/welcome');
          }}
        />
        {config.env !== 'production' ? (
          <Row title="Developer tools" onPress={() => router.push('/dev')} />
        ) : null}
      </Section>
    </Scaffold>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8, marginTop: 12 }}>
      <Text variant="caption" tone="secondary" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}
