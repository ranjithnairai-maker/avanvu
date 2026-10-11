import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { radius } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { config, configured } from '@/lib/config';
import { loadPlans, purchase, restore, type PlanOption } from '@/lib/native/purchases';
import { useTheme } from '@/theme/theme';

/**
 * Paywall (SPEC §13). Prices, trial and renewal terms come only from StoreKit. Annual is highlighted, monthly is
 * shown. Close is always visible; free access continues. No countdowns or urgency.
 */
export default function Paywall() {
  const router = useRouter();
  const qc = useQueryClient();
  const { colors } = useTheme();
  const [plans, setPlans] = useState<PlanOption[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    loadPlans()
      .then((p) => {
        setPlans(p);
        setSelected(p[0]?.id ?? null);
      })
      .catch(() => setPlans([]));
  }, []);

  const plan = plans?.find((p) => p.id === selected) ?? null;
  const finish = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    router.back();
  };
  const buy = async () => {
    if (!plan) return;
    setBusy(true);
    setMessage(null);
    const r = await purchase(plan);
    setBusy(false);
    if (r.ok) await finish();
    else if (!r.cancelled) setMessage(r.message);
  };
  const doRestore = async () => {
    setBusy(true);
    const r = await restore().catch(() => ({ found: false }));
    setBusy(false);
    if (r.found) await finish();
    else setMessage('No purchases to restore were found for this Apple account.');
  };

  return (
    <Scaffold
      title="Avanvu Pro"
      subtitle="More sessions for training and race day, with time held back for your event."
      footer={
        <>
          <Button
            label={plan?.trial ? `Start ${plan.trial}` : 'Subscribe'}
            loading={busy}
            disabled={!plan}
            onPress={buy}
          />
          <Button label="Restore purchases" kind="text" onPress={doRestore} />
          <Button label="Not now" kind="text" onPress={() => router.back()} />
        </>
      }
    >
      {!configured.purchases ? (
        <Notice kind="info">Purchases aren't available in this build. Your free access continues.</Notice>
      ) : null}
      {plans && plans.length === 0 && configured.purchases ? (
        <Notice kind="info">We couldn't load plans. Check your connection and try again.</Notice>
      ) : null}
      {message ? <Notice kind="error">{message}</Notice> : null}
      {plans?.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === p.id }}
          accessibilityLabel={`${p.kind === 'annual' ? 'Annual' : 'Monthly'}, ${p.price} per ${p.period}${p.trial ? `, ${p.trial}` : ''}`}
          onPress={() => setSelected(p.id)}
          style={{
            padding: 16,
            minHeight: 72,
            borderRadius: radius.card,
            backgroundColor: colors.surface,
            borderWidth: selected === p.id ? 1.5 : 1,
            borderColor: selected === p.id ? colors.accent : colors.border,
            gap: 4,
          }}
        >
          <Text variant="headline">{p.kind === 'annual' ? 'Annual' : 'Monthly'}</Text>
          <Text variant="body">
            {p.price} per {p.period}
          </Text>
          {p.trial ? (
            <Text variant="callout" tone="secondary">
              {p.trial}, then {p.price} per {p.period}
            </Text>
          ) : null}
        </Pressable>
      ))}
      <View style={{ gap: 8, marginTop: 8 }}>
        <Text variant="caption" tone="tertiary">
          Payment is charged to your Apple ID. The subscription renews automatically unless cancelled at least
          24 hours before the end of the period. Manage or cancel in your Apple ID settings.
        </Text>
        <Text variant="caption" tone="tertiary">
          Avanvu is mental rehearsal for performance preparation. It is not therapy or medical care.
        </Text>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <Text
            variant="caption"
            tone="accent"
            accessibilityRole="link"
            onPress={() => Linking.openURL(config.termsUrl)}
          >
            Terms of Use
          </Text>
          <Text
            variant="caption"
            tone="accent"
            accessibilityRole="link"
            onPress={() => Linking.openURL(config.privacyUrl)}
          >
            Privacy Policy
          </Text>
        </View>
      </View>
    </Scaffold>
  );
}
