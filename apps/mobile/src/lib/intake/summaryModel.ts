/**
 * The summary card (SPEC §4.3) as data: sections of rows built from the draft profile, with "Add" rows for
 * missing generation-minimum fields. Pure, so the shape of the card and the edits it produces are unit-tested.
 * Every athlete-owned item is editable; edits become ops validated by the server exactly like the model's.
 */
import { FIELD_SPECS, type AthleteProfile, type FieldPath, type ProfileUpdate } from '@avanvu/core';

export type RowKind = 'text' | 'list' | 'key_moment' | 'if_then';

export interface SummaryRow {
  id: string;
  path: FieldPath;
  kind: RowKind;
  /** What the athlete sees. */
  display: string;
  /** Field values to edit in the sheet (one per input). */
  fields: { key: string; label: string; value: string; max: number; multiline?: boolean }[];
  itemId?: string;
  /** A missing essential: shown as an "Add" row. */
  add?: boolean;
  large?: boolean;
}

export interface SummarySection {
  title: string;
  rows: SummaryRow[];
  /** Lists can take more items (up to their maximum). */
  canAdd?: { path: FieldPath; kind: RowKind; label: string }[];
}

const LABELS: Partial<Record<FieldPath, string>> = {
  'objective.primary': 'What you want from this',
  'objective.process_success': 'What success means to you',
  'obstacles.hardest_moment': 'Your hardest moment',
  'responses.cue_phrase': 'Your cue phrase',
  'identity.intention': 'Your intention',
  'scene.visual': 'Something you see',
  'scene.sounds': 'Something you hear',
  'performance.key_moments': 'A key moment',
  'responses.if_then': 'Your plan for the hard moment',
  'outcome.body': 'How the finish feels in your body',
  'outcome.visual': 'What you see at the finish',
};
const label = (p: FieldPath) => LABELS[p] ?? p;

const textRow = (path: FieldPath, value: string | undefined, title = label(path)): SummaryRow => ({
  id: path,
  path,
  kind: 'text',
  display: value ?? '',
  fields: [{ key: 'value', label: title, value: value ?? '', max: FIELD_SPECS[path].max, multiline: true }],
});

const listRows = (path: FieldPath, items: { item_id: string; value: string }[]): SummaryRow[] =>
  items.map((i) => ({
    id: `${path}:${i.item_id}`,
    path,
    kind: 'list' as const,
    display: i.value,
    itemId: i.item_id,
    fields: [{ key: 'value', label: label(path), value: i.value, max: FIELD_SPECS[path].max }],
  }));

/** Which essentials are missing, mapped to the row that adds them. */
const MISSING_TO_PATH: Record<string, FieldPath> = {
  'objective.primary': 'objective.primary',
  'objective.process_success': 'objective.process_success',
  'scene.visual': 'scene.visual',
  'scene.sounds': 'scene.sounds',
  'performance.key_moments': 'performance.key_moments',
  'obstacles.hardest_moment': 'obstacles.hardest_moment',
  'responses.if_then': 'responses.if_then',
  'responses.cue_phrase': 'responses.cue_phrase',
  'identity.intention': 'identity.intention',
  'outcome.visual_or_body': 'outcome.body',
};

export function buildSummary(
  p: AthleteProfile,
  eventName: string,
  missing: readonly string[],
): SummarySection[] {
  const miss = new Set(missing);
  const addRow = (path: FieldPath, kind: RowKind): SummaryRow => ({
    id: `add:${path}`,
    path,
    kind,
    add: true,
    display: `Add: ${label(path).toLowerCase()}`,
    fields:
      kind === 'key_moment'
        ? [
            { key: 'label', label: 'Name this moment', value: '', max: 60 },
            { key: 'description', label: 'What happens', value: '', max: 300, multiline: true },
          ]
        : kind === 'if_then'
          ? [
              { key: 'when', label: 'When this happens', value: '', max: 160 },
              { key: 'then', label: 'I will', value: '', max: 200 },
            ]
          : [{ key: 'value', label: label(path), value: '', max: FIELD_SPECS[path].max, multiline: true }],
  });
  const withAdd = (rows: SummaryRow[], path: FieldPath, key: string, kind: RowKind): SummaryRow[] =>
    miss.has(key) && rows.length === 0 ? [addRow(path, kind)] : rows;

  const sections: SummarySection[] = [];
  sections.push({
    title: 'My objective',
    rows: withAdd(
      p.objective.primary.value ? [textRow('objective.primary', p.objective.primary.value)] : [],
      'objective.primary',
      'objective.primary',
      'text',
    ),
  });
  sections.push({
    title: 'What success means',
    rows: withAdd(
      p.objective.process_success.value
        ? [textRow('objective.process_success', p.objective.process_success.value)]
        : [],
      'objective.process_success',
      'objective.process_success',
      'text',
    ),
  });
  sections.push({
    title: 'My event',
    rows: [
      {
        id: 'event-name',
        path: 'sport.label',
        kind: 'text',
        display: `${eventName}, ${p.sport.label.value}`,
        fields: [],
      },
      ...(p.event.venue?.value ? [textRow('event.venue', p.event.venue.value, 'Where it happens')] : []),
      ...(p.event.stakes?.value ? [textRow('event.stakes', p.event.stakes.value, 'What is at stake')] : []),
    ],
  });
  const scene = [
    ...listRows('scene.visual', p.scene.visual),
    ...listRows('scene.sounds', p.scene.sounds),
    ...listRows('scene.smells', p.scene.smells),
    ...(p.scene.weather_temperature?.value
      ? [textRow('scene.weather_temperature', p.scene.weather_temperature.value, 'Weather and temperature')]
      : []),
    ...listRows('scene.surface_equipment', p.scene.surface_equipment),
  ];
  const sceneAdds: SummaryRow[] = [];
  if (miss.has('scene.visual') && p.scene.visual.length === 0) sceneAdds.push(addRow('scene.visual', 'list'));
  if (miss.has('scene.sounds') && p.scene.sounds.length === 0) sceneAdds.push(addRow('scene.sounds', 'list'));
  sections.push({ title: 'The scene', rows: [...scene, ...sceneAdds] });

  const moments: SummaryRow[] = p.performance.key_moments.map((m) => ({
    id: `km:${m.item_id}`,
    path: 'performance.key_moments' as const,
    kind: 'key_moment' as const,
    itemId: m.item_id,
    display: `${m.label}: ${m.description}`,
    fields: [
      { key: 'label', label: 'Name this moment', value: m.label, max: 60 },
      { key: 'description', label: 'What happens', value: m.description, max: 300, multiline: true },
    ],
  }));
  const needMoments = miss.has('performance.key_moments');
  sections.push({
    title: 'My key moments',
    rows:
      needMoments && moments.length < 2
        ? [...moments, addRow('performance.key_moments', 'key_moment')]
        : moments,
    canAdd:
      p.performance.key_moments.length < 4
        ? [{ path: 'performance.key_moments', kind: 'key_moment', label: 'Add a key moment' }]
        : [],
  });

  const plans: SummaryRow[] = p.responses.if_then.map((i) => ({
    id: `it:${i.item_id}`,
    path: 'responses.if_then' as const,
    kind: 'if_then' as const,
    itemId: i.item_id,
    display: `When ${i.when}, I ${i.then}`,
    fields: [
      { key: 'when', label: 'When this happens', value: i.when, max: 160 },
      { key: 'then', label: 'I will', value: i.then, max: 200 },
    ],
  }));
  sections.push({
    title: 'My hardest moment and my plan',
    rows: [
      ...withAdd(
        p.obstacles.hardest_moment?.value
          ? [textRow('obstacles.hardest_moment', p.obstacles.hardest_moment.value)]
          : [],
        'obstacles.hardest_moment',
        'obstacles.hardest_moment',
        'text',
      ),
      ...listRows('obstacles.negative_self_talk', p.obstacles.negative_self_talk),
      ...withAdd(plans, 'responses.if_then', 'responses.if_then', 'if_then'),
    ],
  });

  sections.push({
    title: 'My cue phrase',
    rows: withAdd(
      p.responses.cue_phrase?.value
        ? [{ ...textRow('responses.cue_phrase', p.responses.cue_phrase.value), large: true }]
        : [],
      'responses.cue_phrase',
      'responses.cue_phrase',
      'text',
    ),
  });
  sections.push({
    title: 'How I want to show up',
    rows: [
      ...(p.identity.hoped_self?.value
        ? [textRow('identity.hoped_self', p.identity.hoped_self.value, 'Who you are becoming')]
        : []),
      ...withAdd(
        p.identity.intention?.value ? [textRow('identity.intention', p.identity.intention.value)] : [],
        'identity.intention',
        'identity.intention',
        'text',
      ),
    ],
  });
  const finish: SummaryRow[] = [
    ...(p.outcome.visual?.value ? [textRow('outcome.visual', p.outcome.visual.value)] : []),
    ...(p.outcome.body?.value ? [textRow('outcome.body', p.outcome.body.value)] : []),
    ...(p.outcome.emotion?.value
      ? [textRow('outcome.emotion', p.outcome.emotion.value, 'How it feels')]
      : []),
  ];
  sections.push({
    title: 'The finish',
    rows:
      miss.has('outcome.visual_or_body') && finish.length === 0
        ? [addRow(MISSING_TO_PATH['outcome.visual_or_body'] as FieldPath, 'text')]
        : finish,
  });
  return sections;
}

/** Turn an edit sheet submission into the op the server validates. */
export function editToUpdates(row: SummaryRow, values: Record<string, string>): ProfileUpdate[] {
  const text = (k: string) => (values[k] ?? '').trim();
  switch (row.kind) {
    case 'text':
      return [{ op: 'set', path: row.path, item_id: '', value: text('value') }];
    case 'list':
      return row.itemId
        ? [{ op: 'replace_item', path: row.path, item_id: row.itemId, value: text('value') }]
        : [{ op: 'add_item', path: row.path, item_id: '', value: text('value') }];
    case 'key_moment':
      return [
        {
          op: row.itemId ? 'replace_item' : 'add_item',
          path: row.path,
          item_id: row.itemId ?? '',
          value: JSON.stringify({ label: text('label'), description: text('description') }),
        },
      ];
    case 'if_then':
      return [
        {
          op: row.itemId ? 'replace_item' : 'add_item',
          path: row.path,
          item_id: row.itemId ?? '',
          value: JSON.stringify({ when: text('when'), then: text('then') }),
        },
      ];
  }
}

export const removeUpdate = (row: SummaryRow): ProfileUpdate[] =>
  row.itemId ? [{ op: 'remove_item', path: row.path, item_id: row.itemId, value: '' }] : [];

/** Edit is valid when every input has text within its limit. */
export function editIsValid(row: SummaryRow, values: Record<string, string>): boolean {
  return row.fields.every((f) => {
    const v = (values[f.key] ?? '').trim();
    return v.length > 0 && v.length <= f.max;
  });
}
