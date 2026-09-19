import type { BattleSettings, BossPhase, ElementCode } from './types';
import { decodeBattleCode } from './share-code';
import defaultDecks from './data/union-default-decks.json';
import recommendation from './data/union-s44-recommendation.json';
import catalog from './data/union-seasons.json';
import { DEFAULT_SYNCHRO_LEVEL } from './model';

/** 회차의 식별 정보. 전투 조건은 아래의 고정된 추천 자료에서 읽는다. */
export interface UnionBossPreset {
  id: string;
  seasonId: string;
  name: string;
  art: string;
  enemyCode: Exclude<ElementCode, ''>;
  weakness: ElementCode;
}

// 출처와 갱신 절차: docs/union-boss-catalog.md.
// 공지의 약점과 엔진에 넘기는 적 코드를 혼동하지 않는다.
export interface UnionBossSeason { id: string; label: string; bosses: UnionBossPreset[] }

// Keep already shared S44 identifiers stable. Other seasons use the source art key.
const S44_IDS: Record<string, string> = {
  bcg002: 'laitance', tombstone: 'tombstone', mbg004_anmi: 'modernia',
  ecg005_re: 'stout', annihilio: 'annihilio',
};
export const UNION_BOSS_SEASONS: UnionBossSeason[] = [...catalog.seasons].reverse().map(season => ({
  id: season.id,
  label: `${season.id.toUpperCase()} · ${season.start}`,
  bosses: season.bosses.map(([code, art, name]) => ({
    id: `${season.id}-${season.id === 's44' ? S44_IDS[art!] : art}`,
    seasonId: season.id, name: name!, art: art!,
    enemyCode: code as Exclude<ElementCode, ''>, weakness: bossWeakness(code as ElementCode),
  })),
}));

/** Infer identity only; never overwrite saved custom battle conditions on reload. */
export function unionSeasonForBosses(bosses: Array<{ bossId?: string }>): UnionBossSeason | undefined {
  return UNION_BOSS_SEASONS.find(season => bosses.length === season.bosses.length
    && season.bosses.every((boss, index) => boss.id === bosses[index]?.bossId));
}

export function unionBossPreset(id: unknown): UnionBossPreset | undefined {
  return UNION_BOSS_SEASONS.flatMap(season => season.bosses).find(boss => boss.id === id);
}

export function unionBossArt(preset: UnionBossPreset): string | undefined {
  // The source lists this art key but its image returned 404 on 2026-09-12.
  if (preset.art === 'bbg004_dmtr_intercept') return undefined;
  return `${import.meta.env.BASE_URL}bosses/${preset.art}.webp`;
}

export function bossWeakness(code: ElementCode): ElementCode {
  return ({ 전격: '철갑', 작열: '수냉', 풍압: '작열', 수냉: '전격', 철갑: '풍압', '': '' } as const)[code];
}

/** 검토해 고정한 회차 추천값. 실행 중 외부 서버 값이 바뀌어도 계산 조건은 바뀌지 않는다. */
export function recommendedUnionBattle(preset: UnionBossPreset): BattleSettings {
  // Historical lineups are verified, but their battle presets are not. Do not
  // accidentally borrow the current season's phases just because elements match.
  const base: BattleSettings = {
    ...decodeBattleCode('NK3-e30'),
    synchroLevel: DEFAULT_SYNCHRO_LEVEL,
    console: { common_level: 0, class_level: {}, company_level: {} },
    enemyCode: preset.enemyCode,
  };
  if (preset.seasonId !== 's44') return base;
  const source = recommendation.cfg.bosses[preset.enemyCode as keyof typeof recommendation.cfg.bosses];
  return {
    ...base,
    duration: recommendation.cfg.duration,
    enemyCode: preset.enemyCode,
    enemyDef: source.def,
    coreEnabled: source.core_px > 0,
    corePx: source.core_px,
    hasParts: source.has_parts,
    optimalRangeWeapons: [...source.optimal_range_weapons],
    normalHitCoeff: { ...source.weapon_coeff },
    // 원본은 단계 사이의 간격만 둔다. 우리 엔진의 누르는 반응 시간을 더하지 않는다.
    burstSwitchDelay: source.burst_switch_delay,
    burstReaction: 0,
    immuneBlocksBurst: false,
    bossPhases: source.phases.map(w => ({ kind: w.kind as BossPhase['kind'], from: w.t0, to: w.t1 })),
  };
}

/**
 * 빈 판을 열었을 때 얹는 **기본 편성**. 없으면 빈 배열이다.
 *
 * **저장된 판이 있으면 부르지 않는다** — 유저의 편성을 덮어쓰지 않는 것이
 * 회차 전환(`applyPreset`)이 `decks`를 그대로 두는 것과 같은 규약이다.
 * 정본과 출처는 `site/src/data/union-default-decks.json`.
 */
export function defaultUnionDecks(preset: UnionBossPreset): string[][] {
  const season = (defaultDecks.seasons as Record<string, Record<string, string[][]>>)[preset.seasonId];
  return (season?.[preset.id] ?? []).map(squad => [...squad]);
}
