/**
 * Pre-account onboarding state (SPEC §8.1): the age check and consent happen before an account exists, so their
 * results are held here and recorded with the API right after sign-in. Nothing is stored for a blocked age
 * result. No birth date is ever held.
 */
import { create } from 'zustand';
import type { AgeOutcome } from '@avanvu/core';

interface OnboardingState {
  age: Extract<AgeOutcome, { result: 'passed' | 'self_attest' }> | null;
  processingConsent: boolean;
  analyticsConsent: boolean;
  /** Set when sport and event are chosen before the interview; sent to the API as the event. */
  sportId: string | null;
  customLabel: string | null;
  customAnswers: boolean[] | null;
  setAge: (a: OnboardingState['age']) => void;
  setConsent: (processing: boolean, analytics: boolean) => void;
  setSport: (id: string, label?: string, answers?: boolean[]) => void;
  reset: () => void;
}

export const useOnboarding = create<OnboardingState>((set) => ({
  age: null,
  processingConsent: false,
  analyticsConsent: false,
  sportId: null,
  customLabel: null,
  customAnswers: null,
  setAge: (age) => set({ age }),
  setConsent: (processingConsent, analyticsConsent) => set({ processingConsent, analyticsConsent }),
  setSport: (sportId, customLabel, customAnswers) =>
    set({ sportId, customLabel: customLabel ?? null, customAnswers: customAnswers ?? null }),
  reset: () =>
    set({
      age: null,
      processingConsent: false,
      analyticsConsent: false,
      sportId: null,
      customLabel: null,
      customAnswers: null,
    }),
}));
