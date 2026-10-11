/**
 * Deterministic safety lexicon (SPEC §12.2 layer 1, CONTRACTS §6.1 banned content).
 *
 * SEED VERSION. The founder's qualified content and safety reviewer (D-30) must finalise this list
 * and the red-team set before any beta. Never weaken it to make a test pass: any change runs the full
 * safety eval set (EVALS §6).
 */
export const LEXICON_VERSION = 'lexicon_seed_2026-10-11';

/** Sports idioms that must not trigger the crisis flow. Removed from the text before matching. */
export const IDIOM_ALLOWLIST: readonly RegExp[] = [
  /\b(?:i|we|you|they|he|she)\s+(?:just\s+)?(?:killed|crushed|smashed|destroyed|nailed|murdered)\s+(?:it|that|them|this|the\s+\w+)\b/gi,
  /\bkill(?:ing)?\s+it\b/gi,
  /\b(?:dying|dead|died)\s+(?:out\s+there|on\s+the\s+(?:hill|climb|course|bike|run)|in\s+the\s+(?:heat|last\s+\w+))\b/gi,
  /\bthat\s+(?:hill|climb|course|set|session|workout|heat)\s+(?:murdered|killed|destroyed)\s+(?:me|us)\b/gi,
  /\b(?:i|we)(?:'d|\s+would)\s+die\s+(?:to|for)\s+(?:win|get|have|be|make|finish|hit)\b/gi,
  /\bdead\s+legs\b/gi,
  /\bsuicides?(?:\s+(?:sprints?|drills?|runs?|lines?))?\b(?=.*\b(?:practice|drill|sprint|training|coach|court|gym|line|warm\s*up)\b)/gi,
];

/** Explicit crisis statements. A match stops the conversation (layer 1). */
export const CRISIS_PATTERNS: readonly RegExp[] = [
  /\bkill(?:ing)?\s+myself\b/i,
  /\bend(?:ing)?\s+(?:my\s+life|it\s+all)\b/i,
  /\bsuicid(?:e|al)\b/i,
  /\b(?:want|wanna|going|plan(?:ning)?)\s+(?:to\s+)?die\b/i,
  /\bdon'?t\s+want\s+to\s+(?:be\s+here|be\s+alive|live|exist)(?:\s+anymore)?\b/i,
  /\b(?:hurt|harm|cut)(?:ting)?\s+myself\b/i,
  /\bself[-\s]?harm\b/i,
  /\bbetter\s+off\s+(?:dead|without\s+me)\b/i,
  /\bno\s+reason\s+to\s+(?:live|go\s+on)\b/i,
];

/** Indirect distress. A match gets the reviewed clarification message instead of the model's question. */
export const AMBIGUOUS_PATTERNS: readonly RegExp[] = [
  /\bcan'?t\s+(?:go\s+on|do\s+this\s+anymore|take\s+(?:it|this)\s+anymore)\b/i,
  /\b(?:feel|feeling|am|i'?m)\s+(?:completely\s+)?(?:hopeless|worthless|empty|numb)\b/i,
  /\bwhat'?s\s+the\s+point\s+of\s+(?:anything|living|any\s+of\s+it)\b/i,
  /\bwish\s+i\s+(?:could\s+)?(?:disappear|wasn'?t\s+here|wouldn'?t\s+wake\s+up)\b/i,
  /\bgive\s+up\s+on\s+everything\b/i,
  /\bnobody\s+(?:would|will)\s+(?:notice|miss)\b/i,
  /\bstarv(?:e|ing)\s+myself\b/i,
  /\bpurg(?:e|ing)\b/i,
];

export type SafetyScreenResult = 'none' | 'ambiguous' | 'crisis';

export function stripIdioms(text: string): string {
  let out = text;
  for (const re of IDIOM_ALLOWLIST) out = out.replace(re, ' ');
  return out;
}

/** Layer 1. Runs before any intake or debrief model call. */
export function screenMessage(text: string): SafetyScreenResult {
  const normalised = text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  const cleaned = stripIdioms(normalised);
  if (CRISIS_PATTERNS.some((re) => re.test(cleaned))) return 'crisis';
  if (AMBIGUOUS_PATTERNS.some((re) => re.test(cleaned))) return 'ambiguous';
  return 'none';
}

export interface BannedRule {
  id: string;
  re: RegExp;
}

/**
 * Content that must never appear in generated scripts (CONTRACTS §6.1). The bare word "weight" is
 * allowed (weightlifting, bodyweight, equipment weight).
 */
export const BANNED_SCRIPT_RULES: readonly BannedRule[] = [
  {
    id: 'manifestation',
    re: /\b(?:manifest(?:ing|ation|s)?|law\s+of\s+attraction|universe\s+(?:will|is))\b/i,
  },
  {
    id: 'guaranteed_results',
    re: /\b(?:guarantee[sd]?|you\s+will\s+(?:win|succeed|get\s+a\s+(?:pb|pr))|certain\s+to\s+(?:win|succeed)|cannot\s+fail|can'?t\s+fail)\b/i,
  },
  {
    id: 'push_through_pain',
    re: /\b(?:push|power|run|play|work|grind)\s+through\s+(?:the\s+|any\s+|that\s+|your\s+)?(?:sharp\s+|sudden\s+)?(?:pain|injury)\b|\bignore\s+(?:the\s+|any\s+|your\s+)?(?:pain|injury)\b/i,
  },
  {
    id: 'weight_loss_diet',
    re: /\b(?:diet(?:ing)?|fasting|purg(?:e|ing)|calorie[s]?|lose\s+weight|weight\s+loss|cut(?:ting)?\s+weight|make\s+weight|restrict(?:ing|ion)?\s+(?:food|eating|calories)|skip\s+(?:meals|eating))\b/i,
  },
  {
    id: 'medical_claim',
    re: /\b(?:clinically\s+proven|treats?\s+(?:anxiety|depression)|cures?|diagnos(?:e|is|ed)|therapy|therapeutic|medical\s+(?:advice|treatment))\b/i,
  },
];

export function findBannedContent(text: string): string[] {
  return BANNED_SCRIPT_RULES.filter((r) => r.re.test(text)).map((r) => r.id);
}

/** Brand claims language (SPEC §1.2): phrases never to use in marketing or UI copy. */
export const BANNED_CLAIM_PHRASES: readonly string[] = [
  'sports psychologist',
  'psychologist-level',
  'clinically proven',
  'treats anxiety',
  'therapy',
  'guaranteed',
  'manifest',
];
