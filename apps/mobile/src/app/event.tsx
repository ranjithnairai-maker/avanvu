import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { getCalendars } from 'expo-localization';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import {
  COMMON_TIME_ZONES,
  MAX_EVENT_MONTHS_AHEAD,
  addMonthsUtc,
  isValidTimeZone,
  timeZoneLabel,
} from '@avanvu/core';
import { Button } from '@/components/Button';
import { DateTimeSheet } from '@/components/DateTimeSheet';
import { Notice } from '@/components/Notice';
import { Row } from '@/components/Row';
import { Scaffold } from '@/components/Scaffold';
import { SelectSheet } from '@/components/SelectSheet';
import { TextField } from '@/components/TextField';
import { api, ApiError } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';

const pad = (n: number) => String(n).padStart(2, '0');
/** The wall-clock fields the athlete picked, regardless of the device's own zone. */
const wall = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function defaultStart(): Date {
  const d = new Date(Date.now() + 7 * 86_400_000);
  d.setHours(8, 0, 0, 0);
  return d;
}

/** Event setup (SPEC §8.2): name, date, start time, time zone. Venue and stakes come from the interview. */
export default function EventSetup() {
  const router = useRouter();
  const { sportId, customLabel, customAnswers } = useOnboarding();
  const deviceZone = getCalendars()[0]?.timeZone ?? 'America/Toronto';
  const zones = useMemo(() => {
    const list = new Set<string>(COMMON_TIME_ZONES);
    if (isValidTimeZone(deviceZone)) list.add(deviceZone);
    return [...list].map((z) => ({ value: z, label: timeZoneLabel(z) }));
  }, [deviceZone]);

  const [name, setName] = useState('');
  const [start, setStart] = useState<Date>(defaultStart);
  const [zone, setZone] = useState(isValidTimeZone(deviceZone) ? deviceZone : 'America/Toronto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(api.newKey());
  const dateSheet = useRef<BottomSheetModal>(null);
  const timeSheet = useRef<BottomSheetModal>(null);
  const zoneSheet = useRef<BottomSheetModal>(null);

  const create = async () => {
    if (!sportId) {
      router.replace('/sport');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ev = await api.post<{ id: string }>(
        '/v1/events',
        {
          name: name.trim(),
          starts_local: wall(start),
          time_zone: zone,
          supported_sport_id: sportId,
          ...(customLabel ? { custom_label: customLabel } : {}),
          ...(customAnswers ? { custom_answers: customAnswers } : {}),
        },
        { idempotencyKey: key.current },
      );
      router.replace({ pathname: '/intake/chat', params: { event: ev.id } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNSUPPORTED_SPORT') router.replace('/waitlist');
      else setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      key.current = api.newKey();
    } finally {
      setBusy(false);
    }
  };

  const now = new Date();
  return (
    <Scaffold
      title="Your event"
      subtitle="When is it? We'll build your program around the date."
      footer={<Button label="Continue" loading={busy} disabled={name.trim().length === 0} onPress={create} />}
    >
      <TextField
        label="Event name"
        placeholder="For example, Fall Marathon"
        value={name}
        onChangeText={(t) => setName(t.slice(0, 120))}
      />
      <Row
        title="Date"
        subtitle={start.toLocaleDateString(undefined, { dateStyle: 'full' })}
        onPress={() => dateSheet.current?.present()}
      />
      <Row
        title="Start time"
        subtitle={start.toLocaleTimeString(undefined, { timeStyle: 'short' })}
        onPress={() => timeSheet.current?.present()}
      />
      <Row title="Time zone" subtitle={timeZoneLabel(zone)} onPress={() => zoneSheet.current?.present()} />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <DateTimeSheet
        ref={dateSheet}
        title="Event date"
        mode="date"
        value={start}
        minimumDate={now}
        maximumDate={addMonthsUtc(now, MAX_EVENT_MONTHS_AHEAD)}
        onDone={(d) =>
          setStart((s) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), s.getHours(), s.getMinutes()))
        }
      />
      <DateTimeSheet
        ref={timeSheet}
        title="Start time"
        mode="time"
        value={start}
        onDone={(d) =>
          setStart((s) => new Date(s.getFullYear(), s.getMonth(), s.getDate(), d.getHours(), d.getMinutes()))
        }
      />
      <SelectSheet
        ref={zoneSheet}
        title="Time zone"
        searchable
        value={zone}
        options={zones}
        onSelect={setZone}
      />
    </Scaffold>
  );
}
