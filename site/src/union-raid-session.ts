import { freshCalibration, readCalibration, type CalibrationState } from './union-raid-calibration';
import type { FiredShot } from './union-raid-live';
import type { RaidPlannerCandidate, RaidPlannerInput } from './union-raid-planner';

export const LIVE_SESSION_KEY = 'nikke-live-raid-session-v1';
export interface LiveSession {
  base: RaidPlannerInput;
  fired: FiredShot[];
  calibration: CalibrationState;
}
export interface LiveBackup extends LiveSession {
  format: 'nikke-live-raid';
  version: 1;
  savedAt: string;
}
export interface LiveRecovery { label: string; snapshot: LiveBackup }
export interface LiveStored { current: LiveBackup; recovery?: LiveRecovery }

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('資料格式不正確');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('名稱或識別資料不完整');
  return value;
};
const number = (value: unknown, min = 0): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error('傷害或血量不是有效數字');
  return value;
};
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result > max) throw new Error('王、階段或隊伍編號不正確');
  return result;
};
const squad = (value: unknown, complete: boolean): string[] => {
  if (!Array.isArray(value) || value.length > 5 || (complete && value.length !== 5)) throw new Error('隊伍編成不完整');
  const names = value.map(text);
  if (new Set(names).size !== names.length) throw new Error('隊伍角色重複');
  return names;
};

/** 只保留實戰需要的欄位；格式驗證完成前不可覆蓋目前盤面。 */
export function readLiveBase(value: unknown): RaidPlannerInput {
  const data = object(value);
  if (!Array.isArray(data.phases) || data.phases.length !== 3) throw new Error('需要三階段血量');
  const phases = data.phases.map(row => {
    if (!Array.isArray(row) || row.length !== 5) throw new Error('每階段需要五隻王的血量');
    return row.map(hp => number(hp));
  });
  if (!Array.isArray(data.candidates) || !data.candidates.length) throw new Error('缺少試算隊伍');
  const candidates: RaidPlannerCandidate[] = data.candidates.map(value => {
    const row = object(value);
    return { id: integer(row.id), memberId: text(row.memberId), memberName: text(row.memberName),
      synchro: number(row.synchro), bossIndex: integer(row.bossIndex, 4), bossName: text(row.bossName),
      deckIndex: integer(row.deckIndex), squad: squad(row.squad, true), damage: number(row.damage),
      ...(typeof row.deckLabel === 'string' ? { deckLabel: row.deckLabel } : {}) };
  });
  const ids = new Set(candidates.map(row => row.id));
  const keys = new Set(candidates.map(row => JSON.stringify([row.memberId, row.bossIndex, row.deckIndex])));
  if (ids.size !== candidates.length || keys.size !== candidates.length) throw new Error('試算隊伍重複');
  return { phases, candidates };
}

export function readLiveShots(value: unknown): FiredShot[] {
  if (!Array.isArray(value)) throw new Error('出刀紀錄格式不正確');
  return value.map(value => {
    const row = object(value);
    const shot: FiredShot = { memberId: text(row.memberId), memberName: text(row.memberName),
      bossIndex: integer(row.bossIndex, 4), bossName: text(row.bossName), phase: integer(row.phase, 3),
      deckIndex: integer(row.deckIndex), squad: squad(row.squad ?? [], false), damage: number(row.damage, Number.MIN_VALUE) };
    if (shot.phase === 3 && shot.bossIndex !== 4) throw new Error('無限階段僅能記錄第五隻王');
    if (typeof row.deckLabel === 'string') shot.deckLabel = row.deckLabel;
    for (const key of ['simulatedDamage', 'predictedDamage'] as const) if (row[key] !== undefined) shot[key] = number(row[key]);
    for (const key of ['finishingShot', 'finishingReviewed'] as const) {
      if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new Error('收尾標記格式不正確');
      if (typeof row[key] === 'boolean') shot[key] = row[key];
    }
    if (row.calibrationSample !== undefined) {
      if (!['verified', 'unreviewed', 'abnormal', 'overflow'].includes(String(row.calibrationSample))) throw new Error('樣本分類不正確');
      shot.calibrationSample = row.calibrationSample as FiredShot['calibrationSample'];
    }
    if (row.calibrationRevision !== undefined) {
      if (typeof row.calibrationRevision !== 'string' || !/^[\w-]{1,100}$/.test(row.calibrationRevision)) throw new Error('校正追蹤資料不正確');
      shot.calibrationRevision = row.calibrationRevision;
    }
    return shot;
  });
}

export function makeLiveBackup(session: LiveSession): LiveBackup {
  // 複製快照，後續修改出刀分類或傷害時不會連帶改寫還原點。
  return JSON.parse(JSON.stringify({ format: 'nikke-live-raid', version: 1, savedAt: new Date().toISOString(), ...session })) as LiveBackup;
}

export function readLiveBackup(value: unknown): LiveBackup {
  const data = object(value);
  if (data.format !== 'nikke-live-raid' || data.version !== 1) throw new Error('不支援此實戰備份版本');
  if (typeof data.savedAt !== 'string' || !Number.isFinite(Date.parse(data.savedAt))) throw new Error('備份時間不正確');
  return { format: 'nikke-live-raid', version: 1, savedAt: data.savedAt,
    base: readLiveBase(data.base), fired: readLiveShots(data.fired), calibration: readCalibration(data.calibration) };
}

export function readLiveImport(value: unknown): LiveSession {
  const data = object(value);
  return 'format' in data ? readLiveBackup(data)
    : { base: readLiveBase(data), fired: [], calibration: freshCalibration() };
}

export function readLiveStored(value: unknown): LiveStored {
  const data = object(value);
  const current = readLiveBackup(data.current);
  if (data.recovery === undefined) return { current };
  const recovery = object(data.recovery);
  return { current, recovery: { label: text(recovery.label), snapshot: readLiveBackup(recovery.snapshot) } };
}

/** 試行的輸入核對門檻，不代表遊戲傷害上限；使用者仍可確認後記錄。 */
export function unusualDamage(actual: number, predicted?: number): boolean {
  return Number.isFinite(predicted) && predicted! > 0 && (actual >= predicted! * 2 || actual <= predicted! * 0.5);
}
