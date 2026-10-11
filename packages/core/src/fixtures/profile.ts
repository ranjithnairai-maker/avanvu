/** Fictional profile fixtures only (CLAUDE.md non-negotiable 9). No real athlete data, ever. */
import { applyProfileUpdates, type ProfileUpdate } from '../intake';
import {
  PROFILE_SCHEMA_VERSION,
  createEmptyProfile,
  recomputeStatuses,
  type AthleteProfile,
} from '../profile';
import type { Engine } from '../sports';

const up = (op: ProfileUpdate['op'], path: string, value = ''): ProfileUpdate => ({
  op,
  path,
  value,
  item_id: '',
});
const km = (label: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ label, description: `${label} during the event`, ...extra });

export interface FictionalOptions {
  engine?: Engine;
  sportId?: string;
  sportLabel?: string;
  cue?: string;
  intention?: string;
  voiceId?: string;
  fearedSelf?: boolean;
  skipPeople?: boolean;
}

/** A complete confirmed profile for a fictional athlete. */
export function fictionalProfile(o: FictionalOptions = {}): AthleteProfile {
  const base = createEmptyProfile({
    supportedSportId: o.sportId ?? 'running_road',
    engine: o.engine ?? 'endurance_v1',
    sportLabel: o.sportLabel ?? 'Road marathon',
    voiceId: o.voiceId ?? 'voice_a',
  });
  const updates: ProfileUpdate[] = [
    up('set', 'objective.primary', 'Finish feeling in control of my race'),
    up('set', 'objective.process_success', 'Hold my planned pace through the first half'),
    up('add_item', 'scene.visual', 'Banners at the start line'),
    up('add_item', 'scene.visual', 'Runners in bright jackets'),
    up('add_item', 'scene.visual', 'Mist over the river'),
    up('add_item', 'scene.sounds', 'Cowbells and cheering'),
    up('add_item', 'scene.sounds', 'Shoes on wet pavement'),
    up('set', 'performance.routine', 'Shake out my arms, three slow breaths, first step'),
    up('add_item', 'performance.key_moments', km('The start', { realtime_seconds: 20 })),
    up('add_item', 'performance.key_moments', km('Kilometre thirty two', { body_feel: 'Heavy legs' })),
    up('set', 'obstacles.hardest_moment', 'Heavy legs and doubt after the bridge'),
    up(
      'add_item',
      'responses.if_then',
      JSON.stringify({ when: 'my legs get heavy', then: 'I shorten my stride and breathe out' }),
    ),
    up('set', 'responses.cue_phrase', o.cue ?? 'Smooth and steady'),
    up('set', 'identity.hoped_self', 'Relaxed shoulders, quiet mind, steady stride'),
    up('set', 'identity.intention', o.intention ?? 'I run my own race'),
    up('set', 'outcome.body', 'Tired, proud, loose shoulders'),
    up('set', 'outcome.emotion', 'Quiet pride'),
  ];
  if (o.fearedSelf)
    updates.push(up('set', 'identity.feared_self', 'Someone who panics and stops running his own race'));
  if (o.skipPeople) updates.push(up('mark_skipped', 'outcome.people'));
  const applied = applyProfileUpdates(base, updates).profile;
  applied.field_status = recomputeStatuses(applied);
  return { ...applied, schema_version: PROFILE_SCHEMA_VERSION };
}
