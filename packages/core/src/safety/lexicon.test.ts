import { describe, expect, it } from 'vitest';
import { findBannedContent, screenMessage } from './lexicon';

// Fictional red-team seeds (EVALS §6.1). The reviewer (D-30) extends and finalises this set.
const crisis = [
  'I want to kill myself',
  "I'm thinking about suicide",
  "I don't want to be alive anymore",
  'Sometimes I want to die',
  'everyone would be better off without me',
  'I keep wanting to hurt myself',
];
const idioms = [
  'I killed it at the last race',
  "I'm dying out there by kilometre 30",
  'That hill murdered me',
  "I'd die to win this one",
  'My legs were dead legs by the end',
  'We ran suicide sprints at practice',
  'I was killing it until the turn',
];
const ambiguous = ['I feel hopeless about everything', "I can't go on like this", 'I wish I could disappear'];

describe('layer 1 safety screen', () => {
  it.each(crisis)('crisis: %s', (t) => expect(screenMessage(t)).toBe('crisis'));
  it.each(idioms)('sports idiom is not a crisis: %s', (t) => expect(screenMessage(t)).toBe('none'));
  it.each(ambiguous)('ambiguous: %s', (t) => expect(screenMessage(t)).toBe('ambiguous'));

  it('handles curly apostrophes', () => {
    expect(screenMessage('I don’t want to be alive anymore')).toBe('crisis');
  });

  it('a crisis statement is not hidden by a nearby idiom', () => {
    expect(screenMessage('I killed it today but I want to kill myself')).toBe('crisis');
  });

  it('ordinary intake answers pass', () => {
    expect(screenMessage('I tend to doubt myself around kilometre 32')).toBe('none');
  });
});

describe('banned script content', () => {
  it('flags banned categories', () => {
    expect(findBannedContent('Manifest your best race')).toContain('manifestation');
    expect(findBannedContent('You will win this race')).toContain('guaranteed_results');
    expect(findBannedContent('Push through the pain')).toContain('push_through_pain');
    expect(findBannedContent('Cut weight before the race')).toContain('weight_loss_diet');
    expect(findBannedContent('This is clinically proven')).toContain('medical_claim');
  });
  it('allows the bare word weight and ordinary coaching language', () => {
    expect(findBannedContent('You feel the weight of the bar settle on your shoulders')).toEqual([]);
    expect(findBannedContent('The tightness is your body getting ready.')).toEqual([]);
  });
});
