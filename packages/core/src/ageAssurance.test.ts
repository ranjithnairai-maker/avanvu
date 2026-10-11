import { describe, expect, it } from 'vitest';
import { decideAgeOutcome, dictationAvailable } from './ageAssurance';

describe('age assurance decision', () => {
  it('passes when the shared range proves 18+', () => {
    expect(decideAgeOutcome({ status: 'shared', lowerBound: 18, upperBound: null }, null)).toEqual({
      result: 'passed',
      method: 'declared_age_range',
    });
  });

  it('blocks under-18 ranges', () => {
    expect(decideAgeOutcome({ status: 'shared', lowerBound: null, upperBound: 17 }, false)).toEqual({
      result: 'blocked',
      reason: 'under_18',
    });
    expect(decideAgeOutcome({ status: 'shared', lowerBound: 13, upperBound: 17 }, null).result).toBe(
      'blocked',
    );
  });

  it('blocks a decline when regulation applies, otherwise falls back to self-attestation', () => {
    expect(decideAgeOutcome({ status: 'declined' }, true)).toEqual({
      result: 'blocked',
      reason: 'sharing_required',
    });
    expect(decideAgeOutcome({ status: 'declined' }, false)).toEqual({
      result: 'self_attest',
      method: 'self_attested',
    });
    expect(decideAgeOutcome({ status: 'unavailable' }, null)).toEqual({
      result: 'self_attest',
      method: 'self_attested',
    });
  });

  it('an empty shared range is treated like a decline', () => {
    expect(decideAgeOutcome({ status: 'shared', lowerBound: null, upperBound: null }, true).result).toBe(
      'blocked',
    );
    expect(decideAgeOutcome({ status: 'shared', lowerBound: null, upperBound: null }, null).result).toBe(
      'self_attest',
    );
  });
});

describe('dictation availability', () => {
  it('requires all three conditions', () => {
    expect(
      dictationAvailable({
        recognitionAvailable: true,
        supportsOnDevice: true,
        localeInstalledOnDevice: true,
      }),
    ).toBe(true);
    expect(
      dictationAvailable({
        recognitionAvailable: true,
        supportsOnDevice: false,
        localeInstalledOnDevice: true,
      }),
    ).toBe(false);
    expect(
      dictationAvailable({
        recognitionAvailable: true,
        supportsOnDevice: true,
        localeInstalledOnDevice: false,
      }),
    ).toBe(false);
  });
});
