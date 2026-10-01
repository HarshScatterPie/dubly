import { describe, expect, it } from 'vitest';
import { getScriptInstruction, isRegionalLanguage, standardHindiLeak } from './languageMeta';

describe('regional language fidelity', () => {
  it('flags Hindi passed off as Kumaoni', () => {
    expect(standardHindiLeak('मेरा नाम राम है और मैं यहाँ बहुत खुश हूँ', 'kfy')).toEqual(expect.arrayContaining(['है', 'मैं']));
  });

  it('accepts a line that is genuinely Kumaoni', () => {
    expect(standardHindiLeak('मेरो नाम राम छ और मी यां भौत खुश छूं', 'kfy')).toEqual([]);
  });

  it('tolerates a single stray Hindi word in a long line', () => {
    expect(standardHindiLeak('तुमर घर कां छ भौत दूर लागूं नहीं कै छ', 'kfy')).toEqual([]);
  });

  it('does not count words a language shares with Hindi', () => {
    expect(standardHindiLeak('म्हारो घर है और थारो भी है', 'raj')).toEqual([]);
  });

  it('leaves non-regional languages alone', () => {
    expect(standardHindiLeak('मेरा नाम राम है', 'hi')).toEqual([]);
    expect(isRegionalLanguage('hi')).toBe(false);
    expect(isRegionalLanguage('kfy')).toBe(true);
  });

  it('puts concrete Kumaoni forms in the prompt', () => {
    const instruction = getScriptInstruction('kfy');
    expect(instruction).toContain('Kumaoni');
    expect(instruction).toContain('है→छ');
  });
});
