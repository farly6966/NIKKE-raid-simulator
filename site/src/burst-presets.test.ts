import { describe, expect, it } from 'vitest';
import { BURST_PRESETS, matchingPresets, presetPicks, presetSequence } from './burst-presets';
import type { BurstSequence } from './burst-order';

describe('편성에 맞는 프리셋 찾기', () => {
  it('필요한 이름이 전부 있으면 뜬다', () => {
    const squad = ['크라운', '마스트 : 로망틱 메이드', '리타', '', ''];
    const presets = matchingPresets(squad);
    expect(presets.map((preset) => preset.id)).toEqual(['crown-mast-romantic-maid']);
  });

  it('한 명이라도 빠지면 안 뜬다', () => {
    expect(matchingPresets(['크라운', '리타', '', '', ''])).toEqual([]);
  });

  it('두 프리셋이 동시에 맞으면 둘 다 뜬다', () => {
    const squad = ['크라운', '마스트 : 로망틱 메이드', '플로라', '', ''];
    const ids = matchingPresets(squad).map((preset) => preset.id);
    expect(ids).toEqual(['crown-mast-romantic-maid', 'flora-crown']);
  });

  it('빈 칸·공백은 이름으로 세지 않는다', () => {
    expect(matchingPresets(['크라운', ' ', '', '마스트 : 로망틱 메이드', ''])
      .map((preset) => preset.id)).toEqual(['crown-mast-romantic-maid']);
  });
});

describe('picks로 펴기', () => {
  const preset = BURST_PRESETS.find((entry) => entry.id === 'crown-mast-romantic-maid')!;

  it('패턴을 사이클 수만큼 반복해 해당 단계만 채운다', () => {
    expect(presetPicks(preset, 4)).toEqual({
      '1:2': '크라운', '2:2': '크라운', '3:2': '마스트 : 로망틱 메이드', '4:2': '크라운',
    });
  });

  it('사이클 하나면 패턴 첫 칸만', () => {
    expect(presetPicks(preset, 1)).toEqual({ '1:2': '크라운' });
  });
});

describe('BurstSequence로 펴기', () => {
  const preset = BURST_PRESETS.find((entry) => entry.id === 'flora-crown')!;

  it('지정한 단계만 채우고 나머지는 빈 칸', () => {
    const sequence = presetSequence(preset, 3);
    expect(sequence).toEqual<BurstSequence>([
      { 1: [], 2: ['플로라'], 3: [] },
      { 1: [], 2: ['크라운'], 3: [] },
      { 1: [], 2: ['플로라'], 3: [] },
    ]);
  });

  it('base를 넘기면 다른 단계는 그대로 두고 해당 단계만 덮어쓴다', () => {
    const base: BurstSequence = [
      { 1: ['리타'], 2: ['상관없음'], 3: [] },
      { 1: [], 2: [], 3: ['앨리스'] },
    ];
    const sequence = presetSequence(preset, 2, base);
    expect(sequence).toEqual<BurstSequence>([
      { 1: ['리타'], 2: ['플로라'], 3: [] },
      { 1: [], 2: ['크라운'], 3: ['앨리스'] },
    ]);
  });

  it('base보다 사이클 수가 많으면 없는 칸은 빈 칸에서 시작한다', () => {
    const base: BurstSequence = [{ 1: ['리타'], 2: [], 3: [] }];
    const sequence = presetSequence(preset, 2, base);
    expect(sequence[1]).toEqual({ 1: [], 2: ['크라운'], 3: [] });
  });
});
