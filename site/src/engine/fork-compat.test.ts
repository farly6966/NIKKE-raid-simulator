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

  it('滿蓄力開火累計觸發減冷卻後，180 秒爆裂循環維持 14 次', () => {
    const squad = build_squad(['루주', '크라운', '마스트 : 로망틱 메이드', '신데렐라', '메이든 : 아이스 로즈']);
    const result = simulate(squad, build_config(squad, { first_burst_time: 3 }), null, true, 42);
    expect(result.log?.burst_log.filter(entry => entry.event === 'full_burst 시작')).toHaveLength(14);
  });

  it('同一施放者的兩個完整爆裂延長效果合計五秒', () => {
    const squad = build_squad(['토브', '나유타', '소다 : 트윙클링 바니', '도로시 : 세렌디피티', '드레이크']);
    const result = simulate(squad, build_config(squad, { duration: 90, rng_mode: 'expected', first_burst_time: 3 }),
      { code: '', core_px: 0 }, true);
    const starts = result.log?.burst_log.filter(entry => entry.event === 'full_burst 시작') ?? [];
    const ends = result.log?.burst_log.filter(entry => entry.event === 'full_burst 종료') ?? [];
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.map((entry, index) => Math.round((entry.t - starts[index]!.t) * 100) / 100))
      .toEqual(ends.map(() => 15));
  });

  it('透芙愛藏品依技能等級計算攻擊次數，彈藥與攻速增益須啟動', () => {
    const squad = build_squad(['토브', '아르카나 : 포츈 메이트', '도로시 : 세렌디피티', '드레이크', '솔린 : 프로스트 티켓']);
    const result = simulate(squad, build_config(squad, { no_burst_char: '솔린 : 프로스트 티켓', first_burst_time: 3 }),
      { code: '풍압' }, true, 42);
    expect(result.log?.instant_events.filter(entry => entry.name === '급조 탄환')).toHaveLength(213);
    expect(result.log?.buff_events.filter(entry => entry.kind === 'activate' && entry.name === '개조 성공 2'))
      .toHaveLength(4);
    expect(result.hits.filter(hit => hit.caster === '드레이크')).toHaveLength(3590);
  });

  it('同攻擊力並列時按原編隊順序選擇增益目標', () => {
    const squad = build_squad(['미란다', '헬름 : 아쿠아마린', '에이드 : 에이전트 바니', '스노우 화이트', '에이다']);
    const result = simulate(squad, build_config(squad, { duration: 10, first_burst_time: 3 }), null, true, 42);
    expect(result.log?.buff_events.filter(entry => entry.kind === 'activate' && entry.name === '파워 업!')
      .map(entry => entry.target)).toEqual(['스노우 화이트', '헬름 : 아쿠아마린']);
  });
});
