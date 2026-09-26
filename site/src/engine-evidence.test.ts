import { describe, expect, it } from 'vitest';
import { engineEvidence } from './engine-evidence';
import type { SimulationRequest, SimulationResult } from './types';

const request: SimulationRequest = {
  squad: ['A', 'B', 'C', 'D', 'E'],
  characters: { A: { skillLevels: { 1: 10, 2: 10, 3: 10 } } },
  duration: 180,
  enemyDef: 31784,
  enemyCode: '작열',
  corePx: 0,
  hasParts: true,
  seed: 42,
  bossPhases: [{ kind: 'parts', from: 10, to: 30 }],
  strictNoBurst: true,
};
const result: SimulationResult = {
  squadTotal: 123456,
  hitCount: 55,
  duration: 180,
  charTotals: { A: 123456 },
  previewNote: '',
  deviations: '',
};

describe('engineEvidence', () => {
  it('保存完整的計算輸入並排除帳號識別資料', () => {
    const evidence = engineEvidence([
      { job: { member: { openid: 'private-id-1' }, bossIndex: 0, deckIndex: 1 }, detail: { request, result } },
      { job: { member: { openid: 'private-id-1' }, bossIndex: 1, deckIndex: 0 }, detail: { request, result } },
      { job: { member: { openid: 'private-id-2' }, bossIndex: 0, deckIndex: 0 }, detail: { request, result } },
    ]);
    expect(evidence.cases.map(item => item.member)).toEqual([1, 1, 2]);
    expect(evidence.cases[0]?.request).toEqual(request);
    expect(evidence.cases[0]?.expected).toEqual({ squadTotal: 123456, hitCount: 55, charTotals: { A: 123456 } });
    expect(JSON.stringify(evidence)).not.toContain('private-id');
  });

  it('略過沒有成功輸出的盤', () => {
    expect(engineEvidence([
      { job: { member: { openid: 'a' }, bossIndex: 0, deckIndex: 0 } },
      { job: { member: { openid: 'b' }, bossIndex: 0, deckIndex: 0 }, detail: { request, result: { ...result, squadTotal: NaN } } },
    ]).cases).toEqual([]);
  });
});
