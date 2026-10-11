import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMON_TIME_ZONES, MAX_EVENT_MONTHS_AHEAD, addMonthsUtc, timeZoneLabel } from '@avanvu/core';
import { Button } from '@/components/Button';
import { DateTimeSheet } from '@/components/DateTimeSheet';
import { Notice } from '@/components/Notice';
import { Row } from '@/components/Row';
import { Scaffold } from '@/components/Scaffold';
import { SelectSheet } from '@/components/SelectSheet';
import { TextField } from '@/components/TextField';
import { api, ApiError } from '@/lib/api';
import { useEvent } from '@/lib/api/queries';
import { scheduleEventReminders } from '@/lib/native/notifications';

const pad = (n: number) => String(n).padStart(2, '0');
const wall = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parse = (s: string) => {
  const [date, time] = s.split('T') as [string, string];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, hh, mm);
};

/** Edit the event (SPEC §8.2): name, date, time, zone. Changing the date rebuilds what has not been generated yet. */
export default function EditEvent() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useEvent(id);
  const [name, setName] = useState('');
  const [start, setStart] = useState(new Date());
  const [zone, setZone] = useState('America/Toronto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState(false);
  const dateSheet = useRef<BottomSheetModal>(null);
  const timeSheet = useRef<BottomSheetModal>(null);
  const zoneSheet = useRef<BottomSheetModal>(null);
  const key = useRef(api.newKey());
  const zones = useMemo(() => COMMON_TIME_ZONES.map((z) => ({ value: z, label: timeZoneLabel(z) })), []);

  useEffect(() => {
    if (!q.data) return;
    setName(q.data.name);
    setStart(parse(q.data.starts_local));
    setZone(q.data.time_zone);
  }, [q.data]);

  const changedTime = q.data ? wall(start) !== q.data.starts_local || zone !== q.data.time_zone : false;
  const save = async () => {
    if (!q.data) return;
    setBusy(true);
    setError(null);
    try {
      const ev = await api.patch<{ id: string; starts_local: string; time_zone: string }>(
        `/v1/events/${id}`,
        { name: name.trim(), ...(changedTime ? { starts_local: wall(start), time_zone: zone } : {}) },
        { idempotencyKey: key.current },
      );
      await scheduleEventReminders({ id: ev.id, starts_local: ev.starts_local, time_zone: ev.time_zone }); // replaces by id
      await qc.invalidateQueries();
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      key.current = api.newKey();
    } finally {
      setBusy(false);
    }
  };

  const now = new Date();
  return (
    <Scaffold
      title="Edit event"
      footer={
        <Button label="Save" loading={busy} disabled={!q.data || name.trim().length === 0} onPress={save} />
      }
    >
      <TextField label="Event name" value={name} onChangeText={(t) => setName(t.slice(0, 120))} />
      <Row
        title="Date"
        subtitle={start.toLocaleDateString(undefined, { dateStyle: 'full' })}
        onPress={() => {
          setWarn(true);
          dateSheet.current?.present();
        }}
      />
      <Row
        title="Start time"
        subtitle={start.toLocaleTimeString(undefined, { timeStyle: 'short' })}
        onPress={() => {
          setWarn(true);
          timeSheet.current?.present();
        }}
      />
      <Row
        title="Time zone"
        subtitle={timeZoneLabel(zone)}
        onPress={() => {
          setWarn(true);
          zoneSheet.current?.present();
        }}
      />
      {warn && changedTime ? (
        <Notice kind="warning">
          Changing the date moves your reminders and your program. Sessions already created keep their
          content.
        </Notice>
      ) : null}
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
