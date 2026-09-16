import {
  optimizeRaidPlan, type MilpSolve, type RaidPlannerCandidate, type RaidPlannerInput,
  type RaidPlannerPlan,
} from './union-raid-planner';

/**
 * 현장에서 확정한 실제 출력 한 발.
 *
 * `candidate`(member × boss × deck)는 전 단계에서 이미 시뮬레이션으로 나온 값이고,
 * 여기 담는 것은 **그중 실제로 쏜 것과, 얼마나 나왔나**뿐이다. `deckIndex`는 계획과
 * 다를 수 있다 — 현장에서 다른 덱으로 쐈으면 그 값을 그대로 적는다. `phase`는 이 발이
 * 어느 혈조에서 나갔는지(0~2는 유한 단계, 3은 무한 5왕)다.
 */
export interface FiredShot {
  memberId: string;
  memberName: string;
  bossIndex: number;
  bossName: string;
  phase: number;
  deckIndex: number;
  /** 隊伍自訂名稱（匯出檔有帶才有）。 */
  deckLabel?: string;
  squad: string[];
  damage: number;
}

/** 이 발이 후보 목록의 어느 candidate와 같은 (사람·왕·덱)인가. */
const shotKey = (row: { memberId: string; bossIndex: number; deckIndex: number }): string =>
  `${row.memberId}::${row.bossIndex}::${row.deckIndex}`;

function usedCharactersByMember(fired: FiredShot[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const shot of fired) {
    const set = map.get(shot.memberId) ?? new Set<string>();
    for (const name of shot.squad) set.add(name);
    map.set(shot.memberId, set);
  }
  return map;
}

/** 이미 쐈다고 확정한 것들과 같은 조합 또는 이미 쓴 캐릭터가 겹치는 후보를 뺀다. */
export function remainingCandidates(
  all: RaidPlannerCandidate[], fired: FiredShot[],
): RaidPlannerCandidate[] {
  const used = new Set(fired.map(shotKey));
  const usedCharacters = usedCharactersByMember(fired);
  return all.filter((candidate) => {
    if (used.has(shotKey(candidate))) return false;
    const characters = usedCharacters.get(candidate.memberId);
    return !characters || !candidate.squad.some((name) => characters.has(name));
  });
}

/**
 * 확정된 발들을 걷어 혈조마다 깎는다. 유한 단계(0~2)만 깎는다 — 무한 5왕(`phase === 3`)은
 * 혈량이 없다. 처치 후 남는 초과 피해는 다음 혈조로 넘어가지 않으므로 0에서 멈춘다.
 */
export function remainingPhases(base: number[][], fired: FiredShot[]): number[][] {
  return base.map((bosses, phase) => bosses.map((hp, bossIndex) => {
    const spent = fired
      .filter((shot) => shot.phase === phase && shot.bossIndex === bossIndex)
      .reduce((total, shot) => total + shot.damage, 0);
    return Math.max(0, hp - spent);
  }));
}

/**
 * 現場真正所在的階段只看已確認傷害，不看最佳化「理論上能推到哪裡」。
 * 0~2 是尚未全清的第一個有限階段；三階段全清後才進無限五王。
 */
export function actualPhaseIndex(base: number[][], fired: FiredShot[]): number {
  const remaining = remainingPhases(base, fired);
  const phase = remaining.findIndex((bosses) => bosses.some((hp) => hp > 0));
  return phase === -1 ? 3 : phase;
}

/** 사람마다 이미 쏜 발 수 — `RaidPlannerInput.alreadyUsed`가 그대로 받는 모양. */
export function usedCounts(fired: FiredShot[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const shot of fired) out[shot.memberId] = (out[shot.memberId] ?? 0) + 1;
  return out;
}

/** 이 (사람·왕·덱)이 원래 후보 목록에 있던 조합인가 — 오기입을 막는 자리. */
export function findCandidate(
  base: RaidPlannerCandidate[], memberId: string, bossIndex: number, deckIndex: number,
): RaidPlannerCandidate | undefined {
  return base.find((candidate) =>
    candidate.memberId === memberId && candidate.bossIndex === bossIndex && candidate.deckIndex === deckIndex);
}

/**
 * 지금까지 확정된 발들을 반영해 남은 문제를 처음부터 다시 푼다.
 *
 * 증분으로 고치지 않는다 — 매번 «원래 후보 목록 − 이미 쏜 것들 + 지금 남은 혈량 +
 * 사람마다 남은 한도»로 문제를 다시 짜서 `optimizeRaidPlan`에 그대로 넘긴다. 그래서
 * 왕이 예상보다 일찍 죽어 발이 남거나, 누가 예상보다 더 쐈거나, 현장에서 다른 덱으로
 * 쐈거나 — 전부 같은 길로 반영된다. 새 규칙을 덧붙일 필요가 없다.
 */
export function resolveLive(
  base: RaidPlannerInput, fired: FiredShot[], solve: MilpSolve, onProgress?: (message: string) => void,
): RaidPlannerPlan {
  const input: RaidPlannerInput = {
    phases: remainingPhases(base.phases, fired),
    candidates: remainingCandidates(base.candidates, fired),
    alreadyUsed: usedCounts(fired),
  };
  return optimizeRaidPlan(input, solve, onProgress);
}
