import type { FiredShot } from './union-raid-live';
import type { RaidPlannerCandidate } from './union-raid-planner';

export interface CalibrationState {
  enabled: boolean;
  factors: Record<string, number>;
  legacyFactorsCleared?: boolean;
}

export const freshCalibration = (): CalibrationState => ({ enabled: false, factors: {} });

/** 同王、相同五人即為同刀型；不以排列、成員或隊伍名稱區分。 */
export function calibrationGroupKey(row: Pick<RaidPlannerCandidate, 'bossIndex' | 'squad'>): string | undefined {
  if (!Number.isInteger(row.bossIndex) || row.bossIndex < 0 || row.bossIndex > 4
    || !Array.isArray(row.squad) || row.squad.length !== 5
    || row.squad.some(name => typeof name !== 'string' || !name.trim())
    || new Set(row.squad).size !== 5) return undefined;
  return JSON.stringify([row.bossIndex, [...row.squad].sort()]);
}

function validGroupKey(key: string): boolean {
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && value.length === 2
      && calibrationGroupKey({ bossIndex: value[0], squad: value[1] }) === key;
  } catch { return false; }
}

/** 儲存狀態不合法時回到關閉；係數不會從另一份匯入資料沿用。 */
export function readCalibration(value: unknown): CalibrationState {
  if (!value || typeof value !== 'object') return freshCalibration();
  const state = value as Partial<CalibrationState>;
  const factors: Record<string, number> = {};
  let legacyFactorsCleared = state.legacyFactorsCleared === true;
  if (state.factors && typeof state.factors === 'object') {
    for (const [key, factor] of Object.entries(state.factors)) {
      if (/^[0-4]$/.test(key)) legacyFactorsCleared = true;
      if (validGroupKey(key) && Number.isFinite(factor) && factor >= 0.5 && factor <= 1.5) factors[key] = factor;
    }
  }
  return { enabled: state.enabled === true, factors, ...(legacyFactorsCleared ? { legacyFactorsCleared: true } : {}) };
}

/** 一律由原始候選值衍生，不改寫原資料，也不連乘已校正值。 */
export function calibratedCandidates(base: RaidPlannerCandidate[], state: CalibrationState): RaidPlannerCandidate[] {
  return base.map(candidate => {
    const key = calibrationGroupKey(candidate);
    return { ...candidate, damage: candidate.damage * (state.enabled && key ? state.factors[key] ?? 1 : 1) };
  });
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function sampleRatio(shot: FiredShot): number | undefined {
  if (!Number.isFinite(shot.simulatedDamage) || !(shot.simulatedDamage! > 0)
    || !Number.isFinite(shot.damage) || shot.damage <= 0) return undefined;
  return shot.damage / shot.simulatedDamage!;
}

export function calibrationSampleStatus(shot: FiredShot): NonNullable<FiredShot['calibrationSample']> {
  // 舊版會自動排除收尾刀；升級後不可把未重新確認的舊紀錄直接納入。
  if (shot.finishingShot && shot.calibrationSample === 'verified' && !shot.finishingReviewed) return 'unreviewed';
  return shot.calibrationSample ?? 'unreviewed';
}

export function calibrationTrend(fired: FiredShot[], group: string) {
  const samples = fired.filter(shot => calibrationGroupKey(shot) === group && calibrationSampleStatus(shot) === 'verified'
    && sampleRatio(shot) !== undefined);
  const ratios = samples.map(shot => sampleRatio(shot)!);
  const members = new Set(samples.map(shot => shot.memberId)).size;
  const factor = ratios.length ? median(ratios) : 1;
  const direction = Math.max(ratios.filter(r => r < 1).length, ratios.filter(r => r > 1).length);
  // 起始產品門檻，不代表統計信賴區間：至少八成落在中位數正負三個百分點內。
  const concentrated = ratios.length > 0 && ratios.filter(r => Math.abs(r - factor) <= 0.03 + 1e-9).length / ratios.length >= 0.8;
  const enough = ratios.length >= 5 && members >= 3;
  const stable = concentrated && direction / ratios.length >= 0.8;
  const ready = enough && stable && Math.abs(factor - 1) >= 0.05 - 1e-9 && factor >= 0.5 && factor <= 1.5;
  return { count: ratios.length, members, factor, enough, stable, ready };
}
