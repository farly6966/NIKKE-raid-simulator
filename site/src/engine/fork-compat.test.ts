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

  it('橋接層套用 Boss 時間窗並拒絕無效設定', () => {
    const blocked = JSON.parse(run_request({ ...request, bossPhases: [{ kind: 'immune', from: 0, to: 10 }] }));
    expect(blocked.squadTotal).toBe(0);
    expect(() => run_request({ ...request, bossPhases: [{ kind: 'unknown', from: 0, to: 5 }] }))
      .toThrow('種類不正確');
    expect(() => run_request({ ...request, burstSwitchDelay: 4 }))
      .toThrow('爆裂階段轉換間隔須為 0～3 秒');
  });

  it('嚴格禁爆從候選移除指定角色', () => {
    const squad = build_squad(['리타']);
    const config = build_config(squad, { duration: 10, first_burst_time: 3, no_burst_char: '리타', strict_no_burst: true });
    const result = simulate(squad, config, null, true, 42);
    expect(result.log?.burst_log.some(entry => entry.event === 'stage:1 사용')).toBe(false);
    expect(() => run_request({ ...request, strictNoBurst: true })).not.toThrow();
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

  it('蓄力武器使用 CDN 指定的開火後搖，維持渡鴉傷害觸發時序', () => {
    const squad = build_squad(['레이븐']);
    const result = simulate(squad, build_config(squad, { duration: 5, rng_mode: 'expected' }), null, false, 42);
    const shots = result.hits.filter(hit => hit.caster === '레이븐' && hit.skill_name === '기본 공격');
    expect(shots).toHaveLength(2);
    expect(shots[0]!.t).toBeCloseTo(1, 4);
    expect(shots[1]!.t).toBeCloseTo(3 + 5 / 60, 4);
  });

  it('限時武器變身結束後原武器重新蓄力', () => {
    const squad = build_squad(['리틀 머메이드', '벨벳', '나유타', '네온 : 비전 아이', '리버렐리오']);
    const result = simulate(squad, build_config(squad, { duration: 20, first_burst_time: 3 }), null, false, 42);
    const shots = result.hits.filter(hit => hit.caster === '벨벳' && hit.hit_tag === 'full_charge_hit');
    expect(shots.slice(0, 4).map(hit => Math.round(hit.t * 1000) / 1000))
      .toEqual([1, 2.4, 14.2, 15.583]);
  });

  it('武器模式結束後回復原武器實效滿彈，避免插入額外裝填', () => {
    const squad = build_squad(['츠바이', '나유타', '프리바티', '스노우 화이트 : 헤비암즈', '리틀 머메이드']);
    const config = build_config(squad, { duration: 16, first_burst_time: 3, no_burst_char: '리틀 머메이드' });
    const result = simulate(squad, config, null, true, 42);
    const restored = result.log?.ammo_log.find(entry => entry.caster === '츠바이'
      && Math.abs(entry.t - (4 + 17 / 60)) < 0.001);
    expect(restored?.ammo).toBe(15);
    const reloads = result.log?.reload_log.filter(entry => entry.caster === '츠바이');
    expect(reloads?.[0]?.t).toBeCloseTo(14.95, 2);
  });

  it('CDN 回掩體武器於開火後搖自動裝填', () => {
    const squad = build_squad(['트리나', '홍련', '아니스 : 스파클링 서머', '프리바티', '목단']);
    const config = build_config(squad, { duration: 20, first_burst_time: 3 });
    const result = simulate(squad, config, { code: '수냉', core_px: 52 }, true, 42);
    const reloads = result.log?.reload_log.filter(entry => entry.caster === '트리나');
    expect(reloads?.[0]?.event).toBe('자동 재장전(엄폐)');
    expect(reloads?.[0]?.t).toBeCloseTo(4 + 11 / 60, 2);
  });

  it('扣除彈藥最低停在零，分段裝填受裝填比例技能影響', () => {
    const squad = build_squad(['리타', '그레이브', '레이', '앨리스', '모더니아']);
    const config = build_config(squad, { duration: 35, first_burst_time: 3 });
    const result = simulate(squad, config, { code: '풍압' }, true, 42);
    const ammo = result.log?.ammo_log.filter(entry => entry.caster === '그레이브') ?? [];
    expect(Math.min(...ammo.map(entry => entry.ammo))).toBe(0);
    expect(ammo.find(entry => Math.abs(entry.t - (30 + 53 / 60)) < 0.001)?.ammo).toBe(0);
    const complete = result.log?.reload_log.find(entry => entry.caster === '그레이브'
      && entry.event === '재장전 완료' && entry.t > 30);
    expect(complete?.t).toBeCloseTo(33 + 48 / 60, 2);
  });

  it('同一發先處理攻擊次數增益，後續命中技能取得新屬性加成', () => {
    const squad = build_squad(['리타', '그레이브', '레이', '앨리스', '모더니아']);
    const config = build_config(squad, { duration: 5, first_burst_time: 3, rng_mode: 'expected' });
    const result = simulate(squad, config, { code: '풍압' }, true, 42);
    const hit = result.hits.find(entry => entry.caster === '레이' && entry.skill_name === '선두 제압 2');
    expect(hit?.t).toBeCloseTo(4 + 8 / 60, 2);
    expect(hit?.damage).toBe(2_091_241);
  });
});
