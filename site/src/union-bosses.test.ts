import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MISSING_ART, UNION_BOSS_SEASONS, averagedWeaponCoeff, bossWeakness, defaultUnionDecks, recommendedUnionBattle, unionBossArt,
  unionRecommendationInfo, unionSeasonForBosses } from './union-bosses';
import { decodeBattleCode, encodeBattleCode } from './share-code';
import { decodeUnionDraft, encodeUnionDraft, readBossCode, readUnionCode, unionCodeOf } from './union-raid';
import { requestForDeck, DEFAULT_SYNCHRO_LEVEL } from './model';
import { setLang, t } from './i18n';
import sourceS44 from './data/union-s44-recommendation.json';
import sourceS45 from './data/union-s45-recommendation.json';
import defaultDecks from './data/union-default-decks.json';
import catalog from '../public/catalog.json';
import { DECK_SLOTS } from './union-raid';

afterEach(() => setLang('ko'));
describe('union boss catalogue', () => {
  it('maps official weaknesses to enemy codes and ships all images', () => {
    const season = (id: string) => UNION_BOSS_SEASONS.find(s => s.id === id)!;
    expect(season('s44').bosses.map(b => b.weakness)).toEqual(['철갑', '수냉', '작열', '전격', '풍압']);
    // S45（2026-10-09 開始）：灼熱・電擊・水冷・風壓・鐵甲 → 弱點依序為水冷・鐵甲・電擊・灼熱・風壓。
    expect(season('s45').bosses.map(b => b.enemyCode)).toEqual(['작열', '전격', '수냉', '풍압', '철갑']);
    expect(season('s45').bosses.map(b => b.weakness)).toEqual(['수냉', '철갑', '전격', '작열', '풍압']);
    expect(UNION_BOSS_SEASONS.map(s => s.id)).toEqual(['s45', 's44', 's43', 's42', 's41', 's40', 's39', 's38', 's37', 's36', 's35']);
    expect(new Set(UNION_BOSS_SEASONS.flatMap(s => s.bosses.map(b => b.id))).size).toBe(55);
    // 既有的 S44 id 不能因為新增期數而改變 —— 已存的盤與 NK4 分享碼靠它還原。
    expect(season('s44').bosses.map(b => b.id)).toEqual(['s44-laitance', 's44-tombstone', 's44-modernia', 's44-stout', 's44-annihilio']);
    for (const season of UNION_BOSS_SEASONS) expect(season.bosses).toHaveLength(5);
    for (const boss of UNION_BOSS_SEASONS.flatMap(s => s.bosses)) {
      expect(bossWeakness(boss.enemyCode)).toBe(boss.weakness);
      if (boss.art === 'bbg004_dmtr_intercept') {
        expect(unionBossArt(boss)).toBeUndefined(); // Source image is unavailable; render a named fallback.
        continue;
      }
      if (MISSING_ART.has(boss.art)) {
        expect(unionBossArt(boss)).toBeUndefined(); // 圖檔尚未收進來，先以名稱顯示。
        continue;
      }
      const path = fileURLToPath(new URL(`../public/bosses/${boss.art}.webp`, import.meta.url));
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).subarray(8, 12).toString()).toBe('WEBP');
      expect(unionBossArt(boss)).toContain('/bosses/');
    }
  });
  it('preserves every recommended phase including duplicate parts through request and share', () => {
    type Raw = { core_px: number; burst_switch_delay: number; first_burst_time: number; burst_reenter_delay: number;
      max_burst_count: number; weapon_coeff: Record<string, number>;
      phases: Array<{ kind: string; t0: number; t1: number; weapons?: string[] }> };
    const sources: Record<string, { cfg: { bosses: Record<string, Raw> } }> = { s44: sourceS44, s45: sourceS45 };
    const recommended = UNION_BOSS_SEASONS.filter(s => unionRecommendationInfo(s.id));
    expect(recommended.map(s => s.id)).toEqual(['s45', 's44']);
    for (const preset of recommended.flatMap(s => s.bosses)) {
      const battle = recommendedUnionBattle(preset);
      const raw = sources[preset.seasonId]!.cfg.bosses[preset.enemyCode]!;
      // 來源的 `range` 就是本引擎的適正距離區間；其餘種類同名。
      const phases = raw.phases.map(w => w.kind === 'range'
        ? { kind: 'optimal_range', from: w.t0, to: w.t1, weapons: w.weapons ?? [] }
        : { kind: w.kind, from: w.t0, to: w.t1 });
      expect(battle.bossPhases).toEqual(phases);
      // 이 회차가 쓰는 타이밍은 엔진 기본값과 같다.
      expect([raw.first_burst_time, raw.burst_reenter_delay, raw.max_burst_count]).toEqual([3, .5, 0]);
      const code = encodeBattleCode(battle);
      const decoded = decodeBattleCode(code);
      expect(decoded.bossPhases ?? []).toEqual(phases);
      const slot = readBossCode({ bossId: preset.id, name: preset.name, code, enabled: true, decks: [] });
      const shared = readUnionCode(unionCodeOf([slot]), [])[0]!;
      expect(shared.bossId).toBe(preset.id);
      expect(shared.battle?.bossPhases ?? []).toEqual(phases);
      const draft = Array.from({ length: 5 }, () => slot);
      expect(decodeUnionDraft(encodeUnionDraft(draft), [])[0]!.bossId).toBe(preset.id);
      const request = requestForDeck({ id: 1, squad: [], characters: {} }, shared.battle!);
      expect(request.bossPhases ?? []).toHaveLength(phases.length);
      expect(request.enemyCode).toBe(preset.enemyCode);
      expect(request.corePx).toBe(raw.core_px);
      expect(request.normalHitCoeff?.MG ?? 1).toBe(raw.weapon_coeff.MG);
      expect(request.duration).toBe(180);
      expect(request.burstReaction).toBe(0);
      expect(request.burstSwitchDelay ?? 0.1).toBe(raw.burst_switch_delay);
    }
  });
  it('keeps reaction time separate from stage switching through sharing and requests', () => {
    const battle = recommendedUnionBattle(UNION_BOSS_SEASONS[0]!.bosses[0]!);
    battle.burstSwitchDelay = 0.35;
    const shared = { ...battle, ...decodeBattleCode(encodeBattleCode(battle)) };
    const request = requestForDeck({ id: 1, squad: [], characters: {} }, shared);
    expect(request.burstSwitchDelay).toBe(0.35);
    expect(request.burstReaction).toBe(0);
    expect(decodeBattleCode('NK3-e30').burstReaction).toBe(0.05);
  });
  it('carries the S45 recommendation: vanish windows, per-window range weapons and averaged coefficients', () => {
    const season = UNION_BOSS_SEASONS.find(s => s.id === 's45')!;
    const by = (code: string) => recommendedUnionBattle(season.bosses.find(b => b.enemyCode === code)!);
    const fire = by('작열');
    expect([fire.enemyDef, fire.corePx, fire.coreEnabled]).toEqual([11607, 60, true]);
    expect(fire.optimalRangeWeapons).toEqual(['MG', 'SR']);
    expect(fire.bossPhases!.filter(p => p.kind === 'vanish')).toHaveLength(15);
    expect(fire.bossPhases).toContainEqual({ kind: 'vanish', from: 17.9, to: 19.2 });
    expect(by('수냉').enemyDef).toBe(12181);
    expect(by('수냉').coreEnabled).toBe(false);
    const wind = by('풍압');
    expect(wind.bossPhases).toContainEqual({ kind: 'optimal_range', from: 63, to: 101, weapons: ['MG'] });
    expect(wind.bossPhases!.filter(p => p.kind === 'vanish')).toHaveLength(5);
    // 風壓王的武器係數在 35~60 秒、106~131 秒切到低檔；本引擎只收一組，取時間加權平均。
    // SMG = (0.8×130 + 0.6×50) ÷ 180，SG = (0.9×130 + 0.5×50) ÷ 180。
    expect(wind.normalHitCoeff).toEqual({ AR: 1, SMG: 0.744, SG: 0.789, SR: 1, RL: 1, MG: 1 });
    // 沒有 boss_stages 的王，係數原樣帶入。
    expect(by('철갑').normalHitCoeff).toEqual({ AR: 1, SMG: 1, SG: 1, SR: 1, RL: 1, MG: 1 });
    expect(averagedWeaponCoeff({ ...sourceS45.cfg.bosses.풍압, boss_stages: [] }, 180).SMG).toBe(0.8);
    // 0.1 秒精度的區間經過分享碼來回不能走樣。
    for (const boss of season.bosses) {
      const battle = recommendedUnionBattle(boss);
      expect(decodeBattleCode(encodeBattleCode(battle)).bossPhases ?? []).toEqual(battle.bossPhases);
    }
  });
  it('uses the fork dictionary for names and interpolated labels in all languages', () => {
    for (const lang of ['zh-TW', 'en', 'ja'] as const) {
      setLang(lang);
      for (const boss of UNION_BOSS_SEASONS.flatMap(s => s.bosses)) expect(t(boss.name)).not.toMatch(/[가-힣]/);
      expect(t('약점: {code}', { code: t('철갑') })).not.toMatch(/[가-힣]/);
      expect(t('최고 피해 {damage} · {n}개 결과', { damage: '123', n: 2 })).not.toMatch(/[가-힣]/);
    }
  });

  it('uses generic historical conditions without leaking current-season phases or core settings', () => {
    const historical = UNION_BOSS_SEASONS.filter(s => !unionRecommendationInfo(s.id));
    expect(historical).toHaveLength(9);
    for (const season of historical) for (const preset of season.bosses) {
      expect(recommendedUnionBattle(preset)).toEqual({ ...decodeBattleCode('NK3-e30'),
        enemyCode: preset.enemyCode, synchroLevel: DEFAULT_SYNCHRO_LEVEL,
        console: { common_level: 0, class_level: {}, company_level: {} } });
    }
    const s43 = UNION_BOSS_SEASONS.find(s => s.id === 's43')!;
    expect(s43.bosses.map(b => b.art)).toEqual(['bcg005', 'eca003', 'bbg002', 'mca003_re', 'ebg002']);
    const board = s43.bosses.map(b => ({ bossId: b.id }));
    expect(unionSeasonForBosses(board)?.id).toBe('s43');
    expect(unionSeasonForBosses([...board].reverse())).toBeUndefined();
    expect(unionSeasonForBosses(board.slice(0, 4))).toBeUndefined();
  });
});

describe('union default decks', () => {
  const names = new Set((catalog as Array<{ name: string }>).map(c => c.name));

  it('only names nikke that exist — a typo would silently leave the slot empty', () => {
    const squads = Object.values(defaultDecks.seasons)
      .flatMap(season => Object.values(season as Record<string, string[][]>)).flat();
    expect(squads.length).toBeGreaterThan(0);
    for (const squad of squads) {
      expect(squad).toHaveLength(5);
      for (const name of squad) expect(names, name).toContain(name);
    }
  });

  it('keys every entry to a boss that exists, and fits the deck slots', () => {
    const ids = new Set(UNION_BOSS_SEASONS.flatMap(s => s.bosses.map(b => b.id)));
    for (const [seasonId, bosses] of Object.entries(defaultDecks.seasons)) {
      for (const [bossId, squads] of Object.entries(bosses as Record<string, string[][]>)) {
        expect(bossId.startsWith(`${seasonId}-`), bossId).toBe(true);
        expect(ids, bossId).toContain(bossId);
        expect(squads.length).toBeLessThanOrEqual(DECK_SLOTS);
      }
    }
  });

  it('serves every season that ships defaults, and an empty list for the rest', () => {
    const bosses = UNION_BOSS_SEASONS.find(s => s.id === 's44')!.bosses;
    for (const boss of bosses) expect(defaultUnionDecks(boss).length, boss.id).toBeGreaterThan(0);
    // S45 的預設編成要等使用者提供自己的實際盤（出處規則見 docs/union-boss-catalog.md）。
    // 在那之前新盤是空的，但不能壞。
    for (const boss of UNION_BOSS_SEASONS[0]!.bosses) expect(defaultUnionDecks(boss)).toEqual([]);
    // 없는 회차는 빈 배열이다 — 기본 편성이 없다고 판이 깨지면 안 된다.
    expect(defaultUnionDecks({ ...bosses[0]!, id: 's43-none', seasonId: 's43' })).toEqual([]);
  });

  it('hands back a copy — callers must not be able to edit the shipped defaults', () => {
    const s44First = UNION_BOSS_SEASONS.find(s => s.id === 's44')!.bosses[0]!;
    const first = defaultUnionDecks(s44First);
    first[0]![0] = '바뀌면 안 된다';
    expect(defaultUnionDecks(s44First)[0]![0]).not.toBe('바뀌면 안 된다');
  });
});
