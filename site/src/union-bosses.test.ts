import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UNION_BOSS_SEASONS, bossWeakness, defaultUnionDecks, recommendedUnionBattle, unionBossArt, unionSeasonForBosses } from './union-bosses';
import { decodeBattleCode, encodeBattleCode } from './share-code';
import { decodeUnionDraft, encodeUnionDraft, readBossCode, readUnionCode, unionCodeOf } from './union-raid';
import { requestForDeck, DEFAULT_SYNCHRO_LEVEL } from './model';
import { setLang, t } from './i18n';
import source from './data/union-s44-recommendation.json';
import defaultDecks from './data/union-default-decks.json';
import catalog from '../public/catalog.json';
import { DECK_SLOTS } from './union-raid';

afterEach(() => setLang('ko'));
describe('union boss catalogue', () => {
  it('maps official weaknesses to enemy codes and ships all images', () => {
    const bosses = UNION_BOSS_SEASONS[0]!.bosses;
    expect(bosses.map(b => b.weakness)).toEqual(['철갑', '수냉', '작열', '전격', '풍압']);
    expect(UNION_BOSS_SEASONS.map(s => s.id)).toEqual(['s44', 's43', 's42', 's41', 's40', 's39', 's38', 's37', 's36', 's35']);
    expect(new Set(UNION_BOSS_SEASONS.flatMap(s => s.bosses.map(b => b.id))).size).toBe(50);
    for (const season of UNION_BOSS_SEASONS) expect(season.bosses).toHaveLength(5);
    for (const boss of UNION_BOSS_SEASONS.flatMap(s => s.bosses)) {
      expect(bossWeakness(boss.enemyCode)).toBe(boss.weakness);
      if (boss.art === 'bbg004_dmtr_intercept') {
        expect(unionBossArt(boss)).toBeUndefined(); // Source image is unavailable; render a named fallback.
        continue;
      }
      const path = fileURLToPath(new URL(`../public/bosses/${boss.art}.webp`, import.meta.url));
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).subarray(8, 12).toString()).toBe('WEBP');
      expect(unionBossArt(boss)).toContain('/bosses/');
    }
  });
  it('preserves every recommended phase including duplicate parts through request and share', () => {
    for (const preset of UNION_BOSS_SEASONS[0]!.bosses) {
      const battle = recommendedUnionBattle(preset);
      const raw = source.cfg.bosses[preset.enemyCode];
      const phases = raw.phases.map(w => ({ kind: w.kind, from: w.t0, to: w.t1 }));
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
  it('uses the fork dictionary for names and interpolated labels in all languages', () => {
    for (const lang of ['zh-TW', 'en', 'ja'] as const) {
      setLang(lang);
      for (const boss of UNION_BOSS_SEASONS.flatMap(s => s.bosses)) expect(t(boss.name)).not.toMatch(/[가-힣]/);
      expect(t('약점: {code}', { code: t('철갑') })).not.toMatch(/[가-힣]/);
      expect(t('최고 피해 {damage} · {n}개 결과', { damage: '123', n: 2 })).not.toMatch(/[가-힣]/);
    }
  });

  it('uses generic historical conditions without leaking current-season phases or core settings', () => {
    for (const season of UNION_BOSS_SEASONS.slice(1)) for (const preset of season.bosses) {
      expect(recommendedUnionBattle(preset)).toEqual({ ...decodeBattleCode('NK3-e30'),
        enemyCode: preset.enemyCode, synchroLevel: DEFAULT_SYNCHRO_LEVEL,
        console: { common_level: 0, class_level: {}, company_level: {} } });
    }
    const s43 = UNION_BOSS_SEASONS[1]!;
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

  it('serves the newest season so a fresh board is not empty', () => {
    const bosses = UNION_BOSS_SEASONS[0]!.bosses;
    for (const boss of bosses) expect(defaultUnionDecks(boss).length, boss.id).toBeGreaterThan(0);
    // 없는 회차는 빈 배열이다 — 기본 편성이 없다고 판이 깨지면 안 된다.
    expect(defaultUnionDecks({ ...bosses[0]!, id: 's43-none', seasonId: 's43' })).toEqual([]);
  });

  it('hands back a copy — callers must not be able to edit the shipped defaults', () => {
    const first = defaultUnionDecks(UNION_BOSS_SEASONS[0]!.bosses[0]!);
    first[0]![0] = '바뀌면 안 된다';
    expect(defaultUnionDecks(UNION_BOSS_SEASONS[0]!.bosses[0]!)[0]![0]).not.toBe('바뀌면 안 된다');
  });
});
