/** Spacing, radius, motion and typography tokens, SPEC §7.3, §7.4, §7.6. */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, x3: 32, x4: 40, x5: 56 } as const;
export const layout = { screenPadding: 20, cardGap: 12, sectionGap: 32 } as const;
export const radius = { chip: 8, input: 12, button: 16, card: 24, full: 9999 } as const;

export const motion = {
  durations: { micro: 150, standard: 250, screen: 400, ambientMin: 800, ambientMax: 1200 },
  entranceEasing: [0.22, 1, 0.36, 1] as const,
  spring: { damping: 18, stiffness: 180 },
  breathing: { inhaleMs: 4000, holdMs: 2000, exhaleMs: 6000 },
} as const;

export type TypeStyleName = 'display' | 'title1' | 'title2' | 'headline' | 'body' | 'callout' | 'caption';

export interface TypeStyle {
  family: 'Manrope' | 'System';
  size: number;
  lineHeight: number;
  weight: '400' | '500' | '600' | '700';
  letterSpacing?: number;
  uppercase?: boolean;
}

export const typography: Record<TypeStyleName, TypeStyle> = {
  display: { family: 'Manrope', size: 34, lineHeight: 40, weight: '700', letterSpacing: -0.4 },
  title1: { family: 'Manrope', size: 28, lineHeight: 34, weight: '700', letterSpacing: -0.4 },
  title2: { family: 'Manrope', size: 22, lineHeight: 28, weight: '600' },
  headline: { family: 'System', size: 17, lineHeight: 22, weight: '600' },
  body: { family: 'System', size: 17, lineHeight: 24, weight: '400' },
  callout: { family: 'System', size: 15, lineHeight: 20, weight: '400' },
  caption: { family: 'System', size: 13, lineHeight: 18, weight: '500', letterSpacing: 0.6, uppercase: true },
};

/** Minimum touch target in points (SPEC §7.8). */
export const MIN_HIT_TARGET = 44;
