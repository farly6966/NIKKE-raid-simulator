import { beforeAll, describe, expect, it } from 'vitest';
import loadHighs, { type Highs } from 'highs';
import { RAID_DAMAGE_SCALE, type MilpSolution, type RaidPlannerCandidate } from './union-raid-planner';
import {
  findCandidate, remainingCandidates, remainingPhases, resolveLive, usedCounts, type FiredShot,
} from './union-raid-live';

const candidate = (id: number, member: number, boss: number, team: number, damage = 60): RaidPlannerCandidate => ({
  id, memberId: `m${member}`, memberName: `Member ${member}`, synchro: 700 + member,
  bossIndex: boss, bossName: `Boss ${boss + 1}`, deckIndex: team,
  squad: Array.from({ length: 5 }, (_, slot) => `m${member}-t${team}-c${slot}`),
  damage: damage * RAID_DAMAGE_SCALE,
});

const shot = (c: RaidPlannerCandidate, phase: number, damage = c.damage): FiredShot => ({
  memberId: c.memberId, memberName: c.memberName, bossIndex: c.bossIndex, bossName: c.bossName,
  phase, deckIndex: c.deckIndex, squad: c.squad, damage,
});

describe('remainingCandidates', () => {
  it('빼는 것은 (사람·왕·덱)이 같은 후보뿐', () => {
    const a = candidate(0, 0, 0, 0);
    const b = candidate(1, 0, 1, 1);
    const left = remainingCandidates([a, b], [shot(a, 0)]);
    expect(left).toEqual([b]);
  });

  it('현장에서 다른 덱으로 쐈으면 원래 계획한 후보는 그대로 남는다', () => {
    const planned = candidate(0, 0, 0, 0);
    const actual = candidate(1, 0, 0, 1);
    const left = remainingCandidates([planned, actual], [shot(actual, 0)]);
    expect(left).toEqual([planned]);
  });

  it('removes later squads that reuse a character already confirmed by the same member', () => {
    const firedCandidate = candidate(0, 0, 0, 0);
    const overlapping = candidate(1, 0, 1, 1);
    overlapping.squad[0] = firedCandidate.squad[0]!;
    const independent = candidate(2, 0, 2, 2);

    expect(remainingCandidates(
      [firedCandidate, overlapping, independent],
      [shot(firedCandidate, 0)],
    )).toEqual([independent]);
  });
});

describe('remainingPhases', () => {
  it('확정된 발만큼 그 혈조에서 깎는다', () => {
    const base = [[100 * RAID_DAMAGE_SCALE, 100 * RAID_DAMAGE_SCALE]];
    const a = candidate(0, 0, 0, 0, 30);
    const out = remainingPhases(base, [shot(a, 0)]);
    expect(out[0]![0]).toBe(70 * RAID_DAMAGE_SCALE);
    expect(out[0]![1]).toBe(100 * RAID_DAMAGE_SCALE);
  });

  it('초과 피해는 0에서 멈추고 다음 혈조로 안 넘어간다', () => {
    const base = [[50 * RAID_DAMAGE_SCALE], [50 * RAID_DAMAGE_SCALE]];
    const a = candidate(0, 0, 0, 0, 90);
    const out = remainingPhases(base, [shot(a, 0)]);
    expect(out[0]![0]).toBe(0);
    expect(out[1]![0]).toBe(50 * RAID_DAMAGE_SCALE);
  });

  it('무한 5왕(phase 3)에서 나간 발은 유한 혈조에 영향을 안 준다', () => {
    const base = [[50 * RAID_DAMAGE_SCALE]];
    const a = candidate(0, 0, 0, 0, 30);
    const out = remainingPhases(base, [shot(a, 3)]);
    expect(out[0]![0]).toBe(50 * RAID_DAMAGE_SCALE);
  });
});

describe('usedCounts / findCandidate', () => {
  it('사람마다 확정된 발 수를 센다', () => {
    const a = candidate(0, 0, 0, 0);
    const b = candidate(1, 0, 1, 1);
    const c = candidate(2, 1, 0, 0);
    expect(usedCounts([shot(a, 0), shot(b, 1), shot(c, 0)])).toEqual({ m0: 2, m1: 1 });
  });

  it('빈 목록이면 빈 표', () => {
    expect(usedCounts([])).toEqual({});
  });

  it('(사람·왕·덱)으로 원래 후보를 찾는다', () => {
    const a = candidate(0, 0, 0, 0);
    const b = candidate(1, 0, 1, 1);
    expect(findCandidate([a, b], 'm0', 1, 1)).toBe(b);
    expect(findCandidate([a, b], 'm0', 2, 2)).toBeUndefined();
  });
});

describe('resolveLive (실제 HiGHS)', () => {
  let highs: Highs;
  beforeAll(async () => { highs = await loadHighs(); });
  const solve = (model: string): MilpSolution => highs.solve(model, { output_flag: false, time_limit: 10 });

  it('확정된 발만큼 후보가 줄고, 그 사람 남은 한도도 줄어든 채로 다시 푼다', () => {
    const a = candidate(0, 0, 0, 0);
    const b = candidate(1, 0, 1, 1);
    const c = candidate(2, 0, 2, 2);
    const hp = Array.from({ length: 3 }, () => Array(5).fill(500 * RAID_DAMAGE_SCALE));
    const plan = resolveLive({ phases: hp, candidates: [a, b, c] }, [shot(a, 0)], solve);
    const member = plan.members.find(m => m.memberId === 'm0')!;
    // a는 이미 확정이라 다시 뽑히지 않는다 — 남은 후보는 b·c 둘뿐이고 한도도 2로 줄었다.
    expect(member.capacity).toBe(2);
    expect(member.shots.every(s => s.deckIndex !== 0)).toBe(true);
  }, 30_000);

  it('왕이 예상보다 일찍 죽으면 남는 발이 다른 왕으로 재배치된다', () => {
    // m0는 boss0을 한 발에 끝낼 만큼 세게 쐈다(원래 계획은 두 발 몫이었다).
    // m0에게는 boss0을 또 때리는 헛수고 선택지(deck1)와 boss1을 돕는 선택지(deck2)가
    // 둘 다 있다 — 이미 죽은 boss0 대신 boss1로 가야 이득이라는 것을 확인한다.
    const overkill = candidate(0, 0, 0, 0, 120);
    const wasted = candidate(1, 0, 0, 1, 80);  // boss0을 또 때리는 선택지(이제 헛수고)
    const useful = candidate(2, 0, 1, 2, 80);  // boss1을 돕는 선택지
    const helps = candidate(3, 1, 1, 0, 80);   // m1이 boss1을 함께 돕는 후보
    const filler = RAID_DAMAGE_SCALE; // 후보가 없는 나머지 왕들 — validate()가 요구하는 자리만 채운다.
    const hp = [
      [100 * RAID_DAMAGE_SCALE, 150 * RAID_DAMAGE_SCALE, filler, filler, filler],
      [filler, filler, filler, filler, filler],
      [filler, filler, filler, filler, filler],
    ];
    const fired: FiredShot[] = [shot(overkill, 0, 120 * RAID_DAMAGE_SCALE)];
    const plan = resolveLive({ phases: hp, candidates: [wasted, useful, helps] }, fired, solve);

    // boss0 phase0은 이미 100억 요구를 120억으로 채웠다 — wasted는 뽑히지 않아야 한다.
    const boss0Bar = plan.bars.find(bar => bar.phase === 0 && bar.bossIndex === 0)!;
    expect(boss0Bar.shots).toHaveLength(0);
    // m0의 남은 한 발은 boss1(useful)로 가야 한다.
    const m0 = plan.members.find(m => m.memberId === 'm0')!;
    expect(m0.shots).toHaveLength(1);
    expect(m0.shots[0]!.bossIndex).toBe(1);
    expect(m0.shots[0]!.deckIndex).toBe(2);
  }, 30_000);
});
