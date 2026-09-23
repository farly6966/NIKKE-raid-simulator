import { describe, expect, it } from 'vitest';
import { calibrationGroupKey } from './union-raid-calibration';
import { makeLiveBackup, readLiveImport, readLiveStored, unusualDamage, type LiveSession } from './union-raid-session';

const row = { memberId: 'm', memberName: '成員', bossIndex: 0, bossName: '一王',
  deckIndex: 0, squad: ['a', 'b', 'c', 'd', 'e'], damage: 100 };
const candidate = { ...row, id: 0, synchro: 700 };
const group = calibrationGroupKey(candidate)!;
const session = (): LiveSession => ({
  base: { phases: Array.from({ length: 3 }, () => Array(5).fill(1000)), candidates: [{ ...candidate }] },
  fired: [{ ...row, phase: 0, damage: 110, simulatedDamage: 100, predictedDamage: 110,
    calibrationSample: 'verified', calibrationRevision: 'test-revision', finishingShot: false }],
  calibration: { enabled: true, factors: { [group]: 1.1 }, revisions: { [group]: 'test-revision' } },
});

describe('實戰進度備份', () => {
  it('還原原始試算、出刀、分類、係數與追蹤版本；不保存其他來源欄位', () => {
    const source = session();
    const backup = makeLiveBackup(source);
    const imported = readLiveImport(JSON.parse(JSON.stringify({ ...backup, irrelevant: '不應保留' })));
    expect(imported).toMatchObject(source);
    expect(imported).not.toHaveProperty('irrelevant');
    source.fired[0]!.damage = 99;
    expect(backup.fired[0]!.damage).toBe(110);
  });

  it('舊試算結果仍可匯入且不帶入其他盤面的紀錄及係數', () => {
    expect(readLiveImport(session().base)).toEqual({ base: session().base, fired: [], calibration: { enabled: false, factors: {} } });
  });

  it.each([
    (v: any) => { v.version = 2; },
    (v: any) => { v.base.phases[0] = [1]; },
    (v: any) => { v.base.candidates[0].damage = '100'; },
    (v: any) => { v.base.candidates[0].squad = ['a']; },
    (v: any) => { v.base.candidates.push(v.base.candidates[0]); },
    (v: any) => { v.fired[0].damage = -10; },
    (v: any) => { v.fired[0].phase = 9; },
    (v: any) => { v.fired[0].calibrationSample = 'automatic'; },
  ])('拒絕不合法的備份', corrupt => {
    const backup = makeLiveBackup(session()); corrupt(backup);
    expect(() => readLiveImport(backup)).toThrow();
  });

  it('目前盤面與上一份還原點可一併讀回，彼此獨立', () => {
    const current = makeLiveBackup(session());
    const recovery = { label: '清空前', snapshot: makeLiveBackup(session()) };
    current.fired = [];
    const stored = readLiveStored(JSON.parse(JSON.stringify({ current, recovery })));
    expect(stored.current.fired).toHaveLength(0);
    expect(stored.recovery?.snapshot.fired).toHaveLength(1);
  });

  it('倍數落差需要核對，但不是傷害上限', () => {
    expect(unusualDamage(200, 100)).toBe(true);
    expect(unusualDamage(50, 100)).toBe(true);
    expect(unusualDamage(110, 100)).toBe(false);
    expect(unusualDamage(50, undefined)).toBe(false);
  });
});
