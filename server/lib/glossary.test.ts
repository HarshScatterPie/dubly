import { describe, expect, it } from 'vitest';
import type { GlossaryEntry } from '../../src/types';
import { applySpokenForms, containsTerm, glossaryInstruction, glossaryMisses, relevantEntries, requiredRendering } from './glossary';
import { buildTranslationPrompt } from './translatePrompt';

const brand: GlossaryEntry = { id: 'g1', term: 'ScatterPie', mode: 'keep', spokenAs: 'Scatter Pie' };
const onboarding: GlossaryEntry = { id: 'g2', term: 'onboarding', mode: 'translate', translations: { hi: 'ऑनबोर्डिंग' } };
const pie: GlossaryEntry = { id: 'g3', term: 'Pie', mode: 'keep' };

describe('glossary matching', () => {
  it('matches Latin terms as whole words, ignoring case', () => {
    expect(containsTerm('Welcome to scatterpie!', 'ScatterPie')).toBe(true);
    expect(containsTerm('A pier by the sea', 'Pie')).toBe(false);
    expect(containsTerm('Apple pie, please', 'Pie')).toBe(true);
  });

  it('matches non-Latin terms as substrings, since those scripts have no reliable word boundary', () => {
    expect(containsTerm('हमारा ऑनबोर्डिंगप्रोसेस', 'ऑनबोर्डिंग')).toBe(true);
  });

  it('keeps only the terms a batch of lines actually uses', () => {
    expect(relevantEntries([brand, onboarding, pie], ['Our onboarding is quick']).map((e) => e.id)).toEqual(['g2']);
  });
});

describe('glossary rules per language', () => {
  it('requires keep terms verbatim and translate terms only where a rendering is set', () => {
    expect(requiredRendering(brand, 'ta')).toBe('ScatterPie');
    expect(requiredRendering(onboarding, 'hi')).toBe('ऑनबोर्डिंग');
    expect(requiredRendering(onboarding, 'ta')).toBeNull();
  });

  it('writes prompt lines only for terms that constrain the language', () => {
    const hi = glossaryInstruction([brand, onboarding], 'hi');
    expect(hi).toContain('"ScatterPie": a name; keep it exactly as "ScatterPie"');
    expect(hi).toContain('"onboarding": always translate as "ऑनबोर्डिंग"');
    expect(glossaryInstruction([onboarding], 'ta')).toBe('');
  });

  it('puts the glossary into the translation prompt', () => {
    const prompt = buildTranslationPrompt([{ id: 'a', text: 'Hi' }], 'Hindi', 'natural', true, '', glossaryInstruction([brand], 'hi'));
    expect(prompt).toContain('GLOSSARY (mandatory');
    expect(prompt).toContain('"ScatterPie"');
    expect(buildTranslationPrompt([{ id: 'a', text: 'Hi' }], 'Hindi', 'natural', true)).not.toContain('GLOSSARY');
  });

  it('reports a term whose required rendering is missing from the translation', () => {
    expect(glossaryMisses('Welcome to ScatterPie onboarding', 'स्कैटरपाई में ऑनबोर्डिंग', [brand, onboarding], 'hi').map((e) => e.id)).toEqual(['g1']);
    expect(glossaryMisses('Welcome to ScatterPie', 'ScatterPie में स्वागत है', [brand], 'hi')).toEqual([]);
    // A term the source never says is not a miss.
    expect(glossaryMisses('Hello there', 'नमस्ते', [brand], 'hi')).toEqual([]);
  });
});

describe('spoken forms', () => {
  it('swaps the term for its respelling in the spoken text only', () => {
    expect(applySpokenForms('ScatterPie में स्वागत है', [brand])).toBe('Scatter Pie में स्वागत है');
  });

  it('treats the respelling literally, even with replacement patterns in it', () => {
    expect(applySpokenForms('Try ScatterPie', [{ ...brand, spokenAs: '$& $1 dollar' }])).toBe('Try $& $1 dollar');
  });
});
