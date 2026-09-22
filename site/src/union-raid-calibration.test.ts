import { describe, expect, it } from 'vitest';
import { calibratedCandidates, calibrationSampleStatus, calibrationTrend, freshCalibration, readCalibration } from './union-raid-calibration';
import type { FiredShot } from './union-raid-live';
import type { RaidPlannerCandidate } from './union-raid-planner';

const shots = (ratios: number[]): FiredShot[] => ratios.map((ratio, index) => ({
  memberId: `m${index}`, memberName: `成員${index}`, bossIndex: 0, bossName: '一王', phase: 0,
  deckIndex: 0, squad: ['a', 'b', 'c', 'd', 'e'], damage: ratio * 100,
  simulatedDamage: 100, predictedDamage: 100, calibrationSample: 'verified', finishingShot: false,
}));

describe('實戰校正', () => {
  it('預設關閉；儲存內容損壞時安全回退', () => {
    expect(freshCalibration()).toEqual({ enabled: false, factors: {} });
    expect(readCalibration(null)).toEqual(freshCalibration());
    expect(readCalibration({ enabled: 'yes', factors: { 0: 0, 1: '0.9', 2: 0.9, 3: Infinity, 4: -1, 5: 1 } }))
      .toEqual({ enabled: false, factors: { 2: 0.9 } });
  });

  it('不足五刀或三人時不建議校正', () => {
    expect(calibrationTrend(shots([0.9, 0.9, 0.9, 0.9]), 0).ready).toBe(false);
    const sameMember = shots([0.9, 0.9, 0.9, 0.9, 0.9]).map(s => ({ ...s, memberId: 'one' }));
    expect(calibrationTrend(sameMember, 0).ready).toBe(false);
  });

  it('識別穩定高低偏差，以原始值為基準，不受當時已採用係數影響', () => {
    const sample = shots([0.91, 0.93, 0.92, 0.94, 0.92]).map(s => ({ ...s, predictedDamage: 92 }));
    expect(calibrationTrend(sample, 0)).toMatchObject({ ready: true, factor: 0.92, count: 5, members: 5 });
    expect(calibrationTrend(shots([1.1, 1.1, 1.1, 1.1, 1.1]), 0).ready).toBe(true);
  });

  it('分散、低於門檻與極端偏差不建議統一校正', () => {
    for (const ratios of [[0.7, 1.15, 0.88, 1.22, 0.95], [0.9, 0.8, 0.7, 0.6, 0.5], Array(5).fill(0.98), Array(5).fill(2)]) {
      expect(calibrationTrend(shots(ratios), 0).ready).toBe(false);
    }
  });

  it('分王隔離，排除未核對、未重新確認的舊收尾、異常及缺少有效基準的紀錄', () => {
    const sample = shots(Array(10).fill(0.9));
    sample[0]!.finishingShot = true;
    sample[1]!.calibrationSample = 'unreviewed';
    sample[2]!.calibrationSample = 'abnormal';
    sample[3]!.simulatedDamage = undefined;
    sample[4]!.simulatedDamage = 0;
    sample[5]!.damage = NaN;
    sample[6]!.bossIndex = 1;
    expect(calibrationTrend(sample, 0).count).toBe(3);
  });

  it('確認完整輸出的極限收尾可以納入；只有人工標記溢出的尾刀因溢出排除', () => {
    const sample = shots(Array(5).fill(0.9));
    sample[0]!.finishingShot = true;
    sample[0]!.finishingReviewed = true;
    expect(calibrationTrend(sample, 0)).toMatchObject({ count: 5, ready: true });
    sample[0]!.calibrationSample = 'overflow';
    expect(calibrationTrend(sample, 0)).toMatchObject({ count: 4, ready: false });
    sample[0]!.finishingShot = false;
    expect(calibrationTrend(sample, 0).count).toBe(4);
    sample[0]!.calibrationSample = 'verified';
    expect(calibrationTrend(sample, 0).count).toBe(5);
  });

  it('舊版自動排除的收尾保持待確認，重新確認後才納入', () => {
    const shot = { ...shots([0.9])[0]!, finishingShot: true };
    expect(calibrationSampleStatus(shot)).toBe('unreviewed');
    expect(calibrationTrend([shot], 0).count).toBe(0);
    shot.finishingReviewed = true;
    expect(calibrationSampleStatus(shot)).toBe('verified');
    expect(calibrationTrend([shot], 0).count).toBe(1);
  });

  it('關閉時不改預估；開啟只影響選定王且不污染原始值', () => {
    const candidates = [{ bossIndex: 0, damage: 100 }, { bossIndex: 1, damage: 200 }] as RaidPlannerCandidate[];
    const state = { enabled: true, factors: { 0: 0.92 } };
    expect(calibratedCandidates(candidates, { ...state, enabled: false })).toEqual(candidates);
    expect(calibratedCandidates(candidates, state).map(c => c.damage)).toEqual([92, 200]);
    expect(calibratedCandidates(candidates, state).map(c => c.damage)).toEqual([92, 200]);
    expect(candidates.map(c => c.damage)).toEqual([100, 200]);
  });
});
