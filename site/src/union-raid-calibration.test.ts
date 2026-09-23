import { describe, expect, it } from 'vitest';
import { calibratedCandidates, calibrationEffect, calibrationGroupKey, calibrationSampleStatus, calibrationTrend, freshCalibration, readCalibration, trackCalibration } from './union-raid-calibration';
import type { FiredShot } from './union-raid-live';
import type { RaidPlannerCandidate } from './union-raid-planner';

const shots = (ratios: number[]): FiredShot[] => ratios.map((ratio, index) => ({
  memberId: `m${index}`, memberName: `成員${index}`, bossIndex: 0, bossName: '一王', phase: 0,
  deckIndex: 0, squad: ['a', 'b', 'c', 'd', 'e'], damage: ratio * 100,
  simulatedDamage: 100, predictedDamage: 100, calibrationSample: 'verified', finishingShot: false,
}));

const group = calibrationGroupKey(shots([1])[0]!)!;

describe('實戰校正', () => {
  it('成效只評估同刀型當次係數的後續完整出刀，不回頭套算舊樣本', () => {
    const training = shots(Array(5).fill(1.1));
    const later = shots([1.1, 1.1, 1.1]).map(s => ({ ...s, predictedDamage: 110, calibrationRevision: 'current' }));
    const excluded = [
      { ...later[0]!, calibrationRevision: 'previous' },
      { ...later[0]!, calibrationSample: 'overflow' as const },
      { ...later[0]!, calibrationSample: 'abnormal' as const },
      { ...later[0]!, calibrationSample: 'unreviewed' as const },
      { ...later[0]!, squad: ['f', 'g', 'h', 'i', 'j'] },
      { ...later[0]!, predictedDamage: undefined },
    ];
    const effect = calibrationEffect([...training, ...later, ...excluded], group, 'current');
    expect(effect.count).toBe(3);
    expect(effect.originalError).toBeCloseTo(10 / 110);
    expect(effect.calibratedError).toBeCloseTo(0);
    expect(calibrationEffect(later, group).count).toBe(0);
  });

  it('至少五筆後續樣本且平均誤差惡化超過一個百分點才提醒撤銷', () => {
    const later = shots(Array(5).fill(1)).map(s => ({ ...s, predictedDamage: 110, calibrationRevision: 'current' }));
    expect(calibrationEffect(later, group, 'current')).toMatchObject({ worse: true, count: 5, originalError: 0 });
    expect(calibrationEffect(later.slice(1), group, 'current').worse).toBe(false);
    expect(calibrationEffect(later.map(s => ({ ...s, predictedDamage: 100.5 })), group, 'current').worse).toBe(false);
  });

  it('新係數開始新追蹤，未變更刀型與備份還原保持原追蹤版本', () => {
    const original = trackCalibration({ enabled: true, factors: { [group]: 1.1 } });
    expect(original.revisions?.[group]).toBeTruthy();
    expect(trackCalibration(readCalibration(original)).revisions).toEqual(original.revisions);
    const same = trackCalibration({ enabled: true, factors: { [group]: 1.1 } }, original);
    expect(same.revisions).toEqual(original.revisions);
    const changed = trackCalibration({ enabled: true, factors: { [group]: 1.2 } }, same);
    expect(changed.revisions?.[group]).not.toBe(original.revisions?.[group]);
    expect(trackCalibration(freshCalibration(), changed).revisions).toBeUndefined();
  });

  it('相同五人忽略順序及隊名；不同王或不同角色不能湊足五刀', () => {
    const sample = shots(Array(5).fill(1.1));
    sample[0]!.squad.reverse();
    sample[0]!.deckIndex = 2;
    sample[0]!.deckLabel = '另一個隊名';
    expect(calibrationTrend(sample, group)).toMatchObject({ count: 5, ready: true });
    sample[3]!.squad = ['a', 'b', 'c', 'd', 'f'];
    sample[4]!.squad = ['a', 'b', 'c', 'd', 'f'];
    expect(calibrationTrend(sample, group)).toMatchObject({ count: 3, ready: false });
    expect(calibrationTrend(sample, calibrationGroupKey(sample[3]!)!)).toMatchObject({ count: 2, ready: false });
    sample[2]!.bossIndex = 1;
    expect(calibrationTrend(sample, group).count).toBe(2);
  });

  it('缺漏、重複或不合法編成無法納入刀型分析', () => {
    for (const squad of [[], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'd'], ['a', 'b', 'c', 'd', ' ']]) {
      const sample = shots(Array(5).fill(1.1)).map(s => ({ ...s, squad }));
      expect(calibrationGroupKey(sample[0]!)).toBeUndefined();
      expect(calibrationTrend(sample, group).count).toBe(0);
    }
  });

  it('恢復新刀型係數，清除舊版全王係數和不合法值', () => {
    const other = calibrationGroupKey({ bossIndex: 1, squad: shots([1])[0]!.squad })!;
    expect(readCalibration({ enabled: true, factors: { [group]: 1.1, [other]: 2, 0: 0.8, invalid: 0.9 } }))
      .toEqual({ enabled: true, factors: { [group]: 1.1 }, legacyFactorsCleared: true });
    expect(readCalibration({ enabled: true, factors: { [group]: 1.1 } }))
      .toEqual({ enabled: true, factors: { [group]: 1.1 } });
  });

  it('係數只調整同王同五人的剩餘候選，換順序仍適用', () => {
    const original: RaidPlannerCandidate = { ...shots([1])[0]!, id: 0, synchro: 700 };
    const candidates: RaidPlannerCandidate[] = [original, { ...original, squad: [...original.squad].reverse(), memberId: 'other', deckIndex: 2 },
      { ...original, squad: ['a', 'b', 'c', 'd', 'f'] }, { ...original, bossIndex: 1 },
      { ...original, squad: [] }];
    expect(calibratedCandidates(candidates, { enabled: true, factors: { [group]: 0.9 } }).map(c => c.damage))
      .toEqual([90, 90, 100, 100, 100]);
  });

  it('預設關閉；儲存內容損壞時安全回退', () => {
    expect(freshCalibration()).toEqual({ enabled: false, factors: {} });
    expect(readCalibration(null)).toEqual(freshCalibration());
    expect(readCalibration({ enabled: 'yes', factors: { 0: 0, 1: '0.9', 2: 0.9, 3: Infinity, 4: -1, 5: 1 } }))
      .toEqual({ enabled: false, factors: {}, legacyFactorsCleared: true });
  });

  it('不足五刀或三人時不建議校正', () => {
    expect(calibrationTrend(shots([0.9, 0.9, 0.9, 0.9]), group).ready).toBe(false);
    const sameMember = shots([0.9, 0.9, 0.9, 0.9, 0.9]).map(s => ({ ...s, memberId: 'one' }));
    expect(calibrationTrend(sameMember, group).ready).toBe(false);
  });

  it('識別穩定高低偏差，以原始值為基準，不受當時已採用係數影響', () => {
    const sample = shots([0.91, 0.93, 0.92, 0.94, 0.92]).map(s => ({ ...s, predictedDamage: 92 }));
    expect(calibrationTrend(sample, group)).toMatchObject({ ready: true, factor: 0.92, count: 5, members: 5 });
    expect(calibrationTrend(shots([1.1, 1.1, 1.1, 1.1, 1.1]), group).ready).toBe(true);
  });

  it('分散、低於門檻與極端偏差不建議統一校正', () => {
    for (const ratios of [[0.7, 1.15, 0.88, 1.22, 0.95], [0.9, 0.8, 0.7, 0.6, 0.5], Array(5).fill(0.98), Array(5).fill(2)]) {
      expect(calibrationTrend(shots(ratios), group).ready).toBe(false);
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
    expect(calibrationTrend(sample, group).count).toBe(3);
  });

  it('確認完整輸出的極限收尾可以納入；只有人工標記溢出的尾刀因溢出排除', () => {
    const sample = shots(Array(5).fill(0.9));
    sample[0]!.finishingShot = true;
    sample[0]!.finishingReviewed = true;
    expect(calibrationTrend(sample, group)).toMatchObject({ count: 5, ready: true });
    sample[0]!.calibrationSample = 'overflow';
    expect(calibrationTrend(sample, group)).toMatchObject({ count: 4, ready: false });
    sample[0]!.finishingShot = false;
    expect(calibrationTrend(sample, group).count).toBe(4);
    sample[0]!.calibrationSample = 'verified';
    expect(calibrationTrend(sample, group).count).toBe(5);
  });

  it('舊版自動排除的收尾保持待確認，重新確認後才納入', () => {
    const shot = { ...shots([0.9])[0]!, finishingShot: true };
    expect(calibrationSampleStatus(shot)).toBe('unreviewed');
    expect(calibrationTrend([shot], group).count).toBe(0);
    shot.finishingReviewed = true;
    expect(calibrationSampleStatus(shot)).toBe('verified');
    expect(calibrationTrend([shot], group).count).toBe(1);
  });

  it('關閉時不改預估；開啟只影響同王同五人且不污染原始值', () => {
    const original: RaidPlannerCandidate = { ...shots([1])[0]!, id: 0, synchro: 700 };
    const candidates: RaidPlannerCandidate[] = [original, { ...original, bossIndex: 1, damage: 200 }];
    const state = { enabled: true, factors: { [group]: 0.92 } };
    expect(calibratedCandidates(candidates, { ...state, enabled: false })).toEqual(candidates);
    expect(calibratedCandidates(candidates, state).map(c => c.damage)).toEqual([92, 200]);
    expect(calibratedCandidates(candidates, state).map(c => c.damage)).toEqual([92, 200]);
    expect(candidates.map(c => c.damage)).toEqual([100, 200]);
  });
});
