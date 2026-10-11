import { describe, expect, it } from 'vitest';
import { colors, type ColorTokens, type ThemeName } from './colors';
import { contrastRatio } from './contrast';

const backgrounds = ['bg', 'surface', 'surfaceRaised'] as const;
const textTokens = [
  'textPrimary',
  'textSecondary',
  'textTertiary',
  'accent',
  'emberText',
  'success',
  'warning',
  'danger',
] as const;

describe.each(['dark', 'light'] as ThemeName[])('WCAG contrast (%s)', (theme) => {
  const t: ColorTokens = colors[theme];

  it.each(textTokens.flatMap((tok) => backgrounds.map((bg) => [tok, bg] as const)))(
    '%s on %s is at least 4.5:1',
    (tok, bg) => {
      expect(contrastRatio(t[tok], t[bg])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('onAccent on accent is at least 4.5:1', () => {
    expect(contrastRatio(t.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(backgrounds)('borderStrong on %s is at least 3:1', (bg) => {
    expect(contrastRatio(t.borderStrong, t[bg])).toBeGreaterThanOrEqual(3);
  });
});
