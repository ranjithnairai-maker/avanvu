/**
 * Age assurance decision logic (SPEC §12.5, D-06). Pure so it is unit-tested off-device; the native
 * Declared Age Range call is a thin wrapper in the mobile app. No birth date is ever stored.
 */
export const MINIMUM_AGE = 18;

export type AgeRangeSignal =
  /** The athlete shared an age range. `lowerBound` is the lower edge of the range, if known. */
  | { status: 'shared'; lowerBound: number | null; upperBound: number | null }
  /** The athlete declined to share. */
  | { status: 'declined' }
  /** The API is unavailable or the request failed. */
  | { status: 'unavailable' };

export type AgeOutcome =
  | { result: 'passed'; method: 'declared_age_range' }
  | { result: 'blocked'; reason: 'under_18' | 'sharing_required' }
  | { result: 'self_attest'; method: 'self_attested' };

/**
 * @param regulationApplies Apple's eligibility signal: `true` regulation applies, `false` it does not,
 * `null` unknown (earlier OS versions, or the request failed). Unknown is treated as "not confirmed".
 */
export function decideAgeOutcome(signal: AgeRangeSignal, regulationApplies: boolean | null): AgeOutcome {
  if (signal.status === 'shared') {
    // The range is trusted only when the lower bound proves 18+. A range that stays below 18 blocks.
    if (signal.lowerBound !== null && signal.lowerBound >= MINIMUM_AGE) {
      return { result: 'passed', method: 'declared_age_range' };
    }
    if (signal.upperBound !== null && signal.upperBound < MINIMUM_AGE) {
      return { result: 'blocked', reason: 'under_18' };
    }
    if (signal.lowerBound !== null && signal.lowerBound < MINIMUM_AGE) {
      return { result: 'blocked', reason: 'under_18' };
    }
    // Shared but empty: treat like a decline.
  }
  if (regulationApplies === true) return { result: 'blocked', reason: 'sharing_required' };
  return { result: 'self_attest', method: 'self_attested' };
}

/** Dictation is offered only when on-device recognition is available for the device and locale (SPEC §4.4). */
export function dictationAvailable(input: {
  recognitionAvailable: boolean;
  supportsOnDevice: boolean;
  localeInstalledOnDevice: boolean;
}): boolean {
  return input.recognitionAvailable && input.supportsOnDevice && input.localeInstalledOnDevice;
}
