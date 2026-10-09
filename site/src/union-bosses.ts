import type { BattleSettings, BossPhase, ElementCode } from './types';
import { decodeBattleCode } from './share-code';
import defaultDecks from './data/union-default-decks.json';
import recommendationS44 from './data/union-s44-recommendation.json';
import recommendationS45 from './data/union-s45-recommendation.json';
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

/** 名單上有、但本機還沒有圖檔的 art key。補進圖檔後從這裡拿掉。 */
export const MISSING_ART = new Set(['xbg001_psid', 'bbg004_dmtr']);

export function unionBossArt(preset: UnionBossPreset): string | undefined {
  // The source lists this art key but its image returned 404 on 2026-09-12.
  if (preset.art === 'bbg004_dmtr_intercept') return undefined;
  // S45 新出現的兩張圖尚未收進 site/public/bosses/（2026-10-09），先以名稱顯示。
  if (MISSING_ART.has(preset.art)) return undefined;
  return `${import.meta.env.BASE_URL}bosses/${preset.art}.webp`;
}

export function bossWeakness(code: ElementCode): ElementCode {
  return ({ 전격: '철갑', 작열: '수냉', 풍압: '작열', 수냉: '전격', 철갑: '풍압', '': '' } as const)[code];
}

/** 推薦設定裡一隻王的原始欄位（DILDORO 分享碼的格式，原樣保存在 data/*.json）。 */
interface RecommendedBoss {
  def: number; core_px: number; has_parts: boolean;
  burst_switch_delay: number;
  optimal_range_weapons: string[];
  phases: Array<{ kind: string; t0: number; t1: number; weapons?: string[] }>;
  weapon_coeff: Record<string, number>;
  /** 從 t 秒起改用這組武器係數（S45 起出現）。 */
  boss_stages?: Array<{ t: number; weapon_coeff: Record<string, number> }>;
}
interface Recommendation {
  code: string;
  cfg: { duration: number; season: number; bosses: Record<string, RecommendedBoss> };
}
/** 有推薦戰鬥條件的期數。新增一期：放進 data/ 並在這裡登記（docs/union-boss-catalog.md）。 */
const RECOMMENDATIONS: Record<string, { data: Recommendation; verified: string }> = {
  s44: { data: recommendationS44 as Recommendation, verified: '2026-09-09' },
  s45: { data: recommendationS45 as Recommendation, verified: '2026-10-09' },
};

/** 這一期有沒有固定的推薦戰鬥條件；有的話回傳核對日期，供畫面標示出處。 */
export function unionRecommendationInfo(seasonId: string | undefined): { season: string; verified: string } | undefined {
  const entry = seasonId ? RECOMMENDATIONS[seasonId] : undefined;
  return entry ? { season: seasonId!.toUpperCase(), verified: entry.verified } : undefined;
}

// 來源的區間種類 → 本引擎的 `BossPhase.kind`。`range` 是來源對適正距離區間的叫法。
const PHASE_KIND: Record<string, BossPhase['kind']> = {
  parts: 'parts', immune: 'immune', element_gate: 'element_gate', core: 'core',
  pierce_gate: 'pierce_gate', vanish: 'vanish', range: 'optimal_range',
};

/**
 * 武器係數。來源若有 `boss_stages`（係數隨時間切換），本引擎目前只收一組全程係數，
 * 所以取**依時間加權的平均** —— 例：S45 風壓王 SMG 0.8（130 秒）／0.6（50 秒）→ 0.744。
 * 總量對得上，但「低係數那段剛好撞上爆裂」的時機差異算不出來。
 */
export function averagedWeaponCoeff(source: RecommendedBoss, duration: number): Record<string, number> {
  const stages = [...(source.boss_stages ?? [])].filter(s => s.t > 0 && s.t < duration).sort((a, b) => a.t - b.t);
  if (stages.length === 0) return { ...source.weapon_coeff };
  const spans = [{ t: 0, weapon_coeff: source.weapon_coeff }, ...stages];
  const out: Record<string, number> = {};
  for (const weapon of Object.keys(source.weapon_coeff)) {
    let sum = 0;
    spans.forEach((span, i) => {
      const end = spans[i + 1]?.t ?? duration;
      sum += (span.weapon_coeff[weapon] ?? source.weapon_coeff[weapon]!) * (end - span.t);
    });
    out[weapon] = Math.round((sum / duration) * 1000) / 1000;
  }
  return out;
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
  const recommendation = RECOMMENDATIONS[preset.seasonId]?.data;
  const source = recommendation?.cfg.bosses[preset.enemyCode];
  if (!recommendation || !source) return base;
  return {
    ...base,
    duration: recommendation.cfg.duration,
    enemyCode: preset.enemyCode,
    enemyDef: source.def,
    coreEnabled: source.core_px > 0,
    corePx: source.core_px,
    hasParts: source.has_parts,
    optimalRangeWeapons: [...source.optimal_range_weapons],
    normalHitCoeff: averagedWeaponCoeff(source, recommendation.cfg.duration),
    // 원본은 단계 사이의 간격만 둔다. 우리 엔진의 누르는 반응 시간을 더하지 않는다.
    burstSwitchDelay: source.burst_switch_delay,
    burstReaction: 0,
    immuneBlocksBurst: false,
    bossPhases: source.phases.map(w => {
      const kind = PHASE_KIND[w.kind];
      // 不認得的種類寧可當場失敗 —— 靜靜丟掉會讓推薦值少一段卻沒人發現。
      if (!kind) throw new Error(`未知的推薦區間種類：${w.kind}`);
      return { kind, from: w.t0, to: w.t1, ...(kind === 'optimal_range' ? { weapons: [...(w.weapons ?? [])] } : {}) };
    }),
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
