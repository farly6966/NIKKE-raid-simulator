import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_DATA_FILES, setEngineData } from './data';
import { run_request } from './bridge';
import { build_config, build_squad } from './spec';
import { simulate } from './timeline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const request = {
  squad: ['리타'], duration: 10, enemyDef: 31784, enemyCode: '',
  corePx: 0, hasParts: false, seed: 42, rngMode: 'expected',
};

beforeAll(() => {
  setEngineData(Object.fromEntries(Object.keys(ENGINE_DATA_FILES).map(path => [
    path, JSON.parse(readFileSync(join(root, path), 'utf8')),
  ])));
});

describe('fork TS 引擎相容邊界', () => {
  it('沿用 fork 固定回充預設值與等級表鍵格式', () => {
    const result = JSON.parse(run_request(request));
    expect(result.squadTotal).toBe(3427327);
    expect(result.hitCount).toBe(240);
  });

  it('尚未移植的聯盟戰條件必須明確失敗', () => {
    expect(() => run_request({ ...request, bossPhases: [{ kind: 'parts', from: 0, to: 5 }] }))
      .toThrow('快速引擎尚未支援此聯盟戰設定');
    expect(() => run_request({ ...request, strictNoBurst: true }))
      .toThrow('快速引擎尚未支援此聯盟戰設定');
    expect(() => run_request({ ...request, burstSwitchDelay: 4 }))
      .toThrow('爆裂階段轉換間隔須為 0～3 秒');
  });

  it('滿蓄力觸發的持續傷害不能消失', () => {
    const squad = build_squad(['레이븐']);
    const result = simulate(squad, build_config(squad, { duration: 10, rng_mode: 'expected' }), null, false, 42);
    expect(result.hits.filter(hit => hit.skill_name === '쇼크웨이브').length).toBeGreaterThan(0);
  });
});
