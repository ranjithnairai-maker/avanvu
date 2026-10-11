/**
 * Data export (SPEC §10.6): a ZIP with one JSON file (account, consents, events, programs, profile
 * versions, retained intake turns, sessions with transcripts, plays, check-ins, debriefs, entitlement
 * summary) plus the session audio files. Stored privately for 72 hours and downloaded through a short-lived
 * signed URL. Never emailed. All decryption happens here, in the worker, for the owner's own data.
 */
import { zipSync, strToU8 } from 'fflate';
import { PROFILE_SCHEMA_VERSION, type SessionTimeline } from '@avanvu/core';
import { withSystemTx, type Db } from '../db/tx';
import type { Logger } from '../observability/logger';
import type { Storage } from '../ports/storage';
import type { Sealer, UserSealer } from '../security/seal';
import { addOutboxEvent, type OutboxDispatcher } from './outbox';

export const EXPORT_TTL_MS = 72 * 3_600_000;

export interface ExportDeps {
  db: Db;
  sealer: Sealer;
  storage: Storage;
  dispatcher?: OutboxDispatcher;
  logger: Logger;
  now: () => Date;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export async function buildExport(deps: ExportDeps, userId: string, sealer: UserSealer): Promise<Uint8Array> {
  const { db } = deps;
  const data = await withSystemTx(db, 'worker', async (trx) => {
    return {
      user: await trx
        .selectFrom('app.users')
        .select(['created_at', 'time_zone', 'age_assurance_method'])
        .where('id', '=', userId)
        .executeTakeFirst(),
      consents: await trx
        .selectFrom('app.consent_records')
        .select(['kind', 'version', 'accepted', 'created_at'])
        .where('user_id', '=', userId)
        .execute(),
      events: await trx.selectFrom('app.events').selectAll().where('user_id', '=', userId).execute(),
      items: await trx
        .selectFrom('app.program_items')
        .select(['kind', 'target_date', 'state', 'program_id'])
        .where('user_id', '=', userId)
        .execute(),
      profiles: await trx
        .selectFrom('app.athlete_profile_versions')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('version')
        .execute(),
      turns: await trx
        .selectFrom('app.intake_turns')
        .select(['id', 'conversation_id', 'seq', 'role', 'content_enc', 'created_at'])
        .where('user_id', '=', userId)
        .where('status', '=', 'committed')
        .orderBy('seq')
        .execute(),
      sessions: await trx
        .selectFrom('app.sessions')
        .select([
          'id',
          'context',
          'length_min',
          'state',
          'created_at',
          'ready_at',
          'duration_ms',
          'audio_path',
        ])
        .where('user_id', '=', userId)
        .execute(),
      scripts: await trx
        .selectFrom('app.session_scripts')
        .select(['session_id', 'timeline_enc'])
        .where('user_id', '=', userId)
        .execute(),
      plays: await trx
        .selectFrom('app.session_plays')
        .select(['session_id', 'mark', 'position_ms', 'occurred_at'])
        .where('user_id', '=', userId)
        .execute(),
      checkins: await trx.selectFrom('app.checkins').selectAll().where('user_id', '=', userId).execute(),
      debriefs: await trx
        .selectFrom('app.event_debriefs')
        .selectAll()
        .where('user_id', '=', userId)
        .execute(),
      entitlement: await trx
        .selectFrom('app.entitlements')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    };
  });

  const open = <T>(table: string, column: string, rowId: string, schema: string, bytes: Uint8Array | null) =>
    bytes
      ? sealer.open<T>({ table, column, rowId, schemaVersion: schema }, bytes)
      : Promise.resolve(null as T | null);

  const events = [];
  for (const e of data.events) {
    events.push({
      id: e.id,
      name: await open<string>('events', 'name_enc', e.id, 'event_name_v1', e.name_enc),
      sport_label: await open<string>('events', 'sport_label_enc', e.id, 'sport_label_v1', e.sport_label_enc),
      starts_at: iso(e.starts_at),
      time_zone: e.time_zone,
      sport: e.supported_sport_id,
      status: e.status,
    });
  }
  const profile_versions = [];
  for (const p of data.profiles) {
    profile_versions.push({
      version: p.version,
      source: p.source,
      created_at: iso(p.created_at),
      profile: await open(
        'athlete_profile_versions',
        'profile_enc',
        p.id,
        PROFILE_SCHEMA_VERSION,
        p.profile_enc,
      ),
    });
  }
  const intake_turns = [];
  for (const t of data.turns) {
    // Raw turns are retained only for 90 days after confirmation; what is still here is exported.
    intake_turns.push({
      conversation_id: t.conversation_id,
      seq: t.seq,
      role: t.role,
      created_at: iso(t.created_at),
      text:
        (await open<{ text: string }>('intake_turns', 'content_enc', t.id, 'intake_turn_v1', t.content_enc))
          ?.text ?? null,
    });
  }
  const sessions = [];
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  for (const s of data.sessions) {
    const script = data.scripts.find((x) => x.session_id === s.id);
    const timeline = script
      ? await open<SessionTimeline>(
          'session_scripts',
          'timeline_enc',
          s.id,
          'session_timeline_v1',
          script.timeline_enc,
        )
      : null;
    sessions.push({
      id: s.id,
      context: s.context,
      length_min: s.length_min,
      state: s.state,
      created_at: iso(s.created_at),
      duration_ms: s.duration_ms,
      transcript:
        timeline?.items.map((i) =>
          i.type === 'speech'
            ? { type: 'speech', block: i.block, text: i.text }
            : { type: i.type, block: i.block, seconds: Math.round(i.duration_ms / 1000) },
        ) ?? null,
      audio_file: s.audio_path ? `audio/${s.id}.m4a` : null,
    });
    if (s.audio_path) {
      const audio = await deps.storage.get('audio', s.audio_path);
      if (audio) files[`audio/${s.id}.m4a`] = [audio, { level: 0 }];
    }
  }
  const checkins = [];
  for (const c of data.checkins) {
    checkins.push({
      session_id: c.session_id,
      vividness: c.vividness,
      readiness: c.readiness,
      created_at: iso(c.created_at),
      useful: await open<string>('checkins', 'useful_enc', c.session_id, 'checkin_text_v1', c.useful_enc),
      off: await open<string>('checkins', 'off_enc', c.session_id, 'checkin_text_v1', c.off_enc),
    });
  }
  const debriefs = [];
  for (const d of data.debriefs) {
    debriefs.push({
      event_id: d.event_id,
      overall: d.overall,
      created_at: iso(d.created_at),
      answers: await open('event_debriefs', 'answers_enc', d.id, 'debrief_answers_v1', d.answers_enc),
      confirmed_items: d.confirmed_items,
    });
  }

  const json = {
    exported_at: deps.now().toISOString(),
    account: {
      created_at: iso(data.user?.created_at ?? null),
      time_zone: data.user?.time_zone ?? null,
      age_check: data.user?.age_assurance_method ?? null,
    },
    consents: data.consents.map((c) => ({ ...c, created_at: iso(c.created_at) })),
    events,
    program_items: data.items,
    profile_versions,
    intake_turns,
    sessions,
    plays: data.plays.map((p) => ({ ...p, occurred_at: iso(p.occurred_at) })),
    checkins,
    debriefs,
    entitlement: data.entitlement
      ? {
          active: data.entitlement.active,
          period_type: data.entitlement.period_type,
          product: data.entitlement.product,
          expires_at: iso(data.entitlement.expires_at),
        }
      : null,
  };
  return zipSync({ 'avanvu-export.json': strToU8(JSON.stringify(json, null, 2)), ...files } as never);
}

export async function runExport(
  deps: ExportDeps,
  jobId: string,
): Promise<{ status: number; result: string }> {
  const { db } = deps;
  const job = await withSystemTx(db, 'worker', (trx) =>
    trx.selectFrom('app.export_jobs').selectAll().where('id', '=', jobId).executeTakeFirst(),
  );
  if (!job) return { status: 200, result: 'unknown_job' };
  if (job.state === 'ready' || job.state === 'expired') return { status: 200, result: job.state };
  try {
    const claimed = await withSystemTx(db, 'worker', (trx) =>
      trx
        .updateTable('app.export_jobs')
        .set((eb) => ({ state: 'running', attempt: eb('attempt', '+', 1) }))
        .where('id', '=', jobId)
        .where('state', 'in', ['queued', 'running'])
        .executeTakeFirst(),
    );
    if (Number(claimed.numUpdatedRows) !== 1) return { status: 200, result: 'skipped' };
    const sealer = await deps.sealer.forUser(job.user_id);
    const zip = await buildExport(deps, job.user_id, sealer);
    const path = `exports/${job.user_id}/${jobId}.zip`;
    await deps.storage.put('exports', path, zip, 'application/zip');
    const outboxId = await withSystemTx(db, 'worker', async (trx) => {
      await trx
        .updateTable('app.export_jobs')
        .set({
          state: 'ready',
          storage_path: path,
          expires_at: new Date(deps.now().getTime() + EXPORT_TTL_MS),
        })
        .where('id', '=', jobId)
        .execute();
      const d = await trx
        .insertInto('app.notification_deliveries')
        .values({ user_id: job.user_id, kind: 'export_ready', subject_id: jobId } as never)
        .onConflict((oc) => oc.columns(['user_id', 'kind', 'subject_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return d ? addOutboxEvent(trx, { userId: job.user_id, kind: 'push', subjectId: d.id }) : null;
    });
    if (outboxId) await deps.dispatcher?.dispatchAfterCommit([outboxId]);
    return { status: 200, result: 'ready' };
  } catch {
    deps.logger.warn('export_retry', {});
    return { status: 503, result: 'retry' };
  }
}
