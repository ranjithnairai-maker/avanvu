/**
 * Safety copy and crisis resources (SPEC §12.2). SEED TEXT: wording and per-territory resources are
 * reviewed and approved by the founder's content and safety reviewer before beta (D-29, D-30). Resources
 * come from configuration per launch territory, never from the model.
 */
export const SAFETY_COPY_VERSION = 'safety_copy_seed_2026-10-11';

/** Shown instead of the model's question when the signal is ambiguous (brief, non-leading). */
export const AMBIGUOUS_CLARIFICATION_MESSAGE =
  'I want to check in with you. How are you doing right now? We can pause the interview at any time, and there is no rush.';

export type Territory = 'CA' | 'US' | 'OTHER';

export interface CrisisResource {
  id: string;
  label: string;
  kind: 'call' | 'text' | 'link';
  value: string;
}

export interface CrisisCard {
  title: string;
  body: string;
  resources: CrisisResource[];
  leaveLabel: string;
}

const EMERGENCY: Record<Territory, CrisisResource> = {
  CA: { id: 'emergency', label: 'Emergency services', kind: 'call', value: '911' },
  US: { id: 'emergency', label: 'Emergency services', kind: 'call', value: '911' },
  OTHER: {
    id: 'emergency',
    label: 'Your local emergency number',
    kind: 'link',
    value: 'https://findahelpline.com',
  },
};

/** Crisis card content per territory. Never labels or diagnoses the athlete. */
export function crisisCardFor(territory: Territory): CrisisCard {
  const resources: CrisisResource[] = [];
  if (territory === 'CA' || territory === 'US') {
    resources.push({ id: '988-call', label: 'Call 9-8-8', kind: 'call', value: '988' });
    resources.push({ id: '988-text', label: 'Text 9-8-8', kind: 'text', value: '988' });
  }
  resources.push(EMERGENCY[territory]);
  if (territory === 'OTHER') {
    resources.push({
      id: 'directory',
      label: 'Find a helpline near you',
      kind: 'link',
      value: 'https://findahelpline.com',
    });
  }
  return {
    title: 'Support is available',
    body: "What you shared matters more than any session. Avanvu can't help with this, but people who can are available right now. You can come back to Avanvu whenever you like.",
    resources,
    leaveLabel: 'Back to Home',
  };
}

export function territoryFromStorefront(countryCode: string | null | undefined): Territory {
  const c = (countryCode ?? '').toUpperCase();
  return c === 'CA' || c === 'US' ? c : 'OTHER';
}
