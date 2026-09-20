import { beforeAll, describe, expect, it } from 'vitest';
import loadHighs, { type Highs } from 'highs';
import type { JobResult } from './union-raid';
import {
  RAID_DAMAGE_SCALE, TIE_BUDGET_SECONDS, memberAttackCapacity, optimizeRaidPlan, plannerCandidates,
  type MilpSolution, type RaidPlannerCandidate,
} from './union-raid-planner';

let highs: Highs;
beforeAll(async () => { highs = await loadHighs(); });

const candidate = (id: number, member: number, boss: number, team: number, damage = 60): RaidPlannerCandidate => ({
  id, memberId: `m${member}`, memberName: `Member ${member}`, synchro: 700 + member,
  bossIndex: boss, bossName: `Boss ${boss + 1}`, deckIndex: team,
  squad: Array.from({ length: 5 }, (_, slot) => `m${member}-t${team}-c${slot}`),
  damage: damage * RAID_DAMAGE_SCALE,
});

const solve = (model: string): MilpSolution => highs.solve(model, { output_flag: false, time_limit: 10 });

describe('global staged union raid planner', () => {
  it('exports the team name with each candidate when the deck has one', () => {
    const job = (deckIndex: number, deckLabel?: string) => ({
      member: { openid: 'o1', name: 'A', synchro: 700 }, bossIndex: 0, bossName: 'B1', deckIndex,
      ...(deckLabel ? { deckLabel } : {}), squad: ['a', 'b', 'c', 'd', 'e'].map(n => `${n}${deckIndex}`),
    });
    const rows = [
      { job: job(0, '紅蓮速攻'), damage: 1 },
      { job: job(1), damage: 1 },
    ] as unknown as JobResult[];
    const [named, plain] = plannerCandidates(rows);
    expect(named!.deckLabel).toBe('紅蓮速攻');
    expect(plain).not.toHaveProperty('deckLabel');
  });

  it('counts zero to three usable attacks from actual conflict-free candidates', () => {
    const a = candidate(0, 0, 0, 0);
    const b = candidate(1, 0, 1, 1);
    expect(memberAttackCapacity([a, b])).toBe(2);
    expect(memberAttackCapacity([a, { ...b, squad: [...a.squad] }])).toBe(1);
    expect(memberAttackCapacity([])).toBe(0);
  });

  it('keeps advancing phases when the caller loosened the MIP gap', () => {
    // gap을 준 HiGHS는 «그 오차 안에서 최적»에도 `Status: 'Optimal'`을 준다 — 즉
    // incumbent가 진짜 최적보다 gap만큼 낮을 수 있다. 그 값을 정확 문턱과 그대로 견주면
    // **깰 수 있는 단계를 못 깬다고 읽고** 그 뒤를 통째로 포기한다. 2026-09-20 실측:
    // gap 2%면 1초 만에 `reached: phase1`로 끝났다.
    //
    // 작은 판에서는 HiGHS가 gap을 줘도 정확해를 찾아 버려 재현되지 않는다. 그래서
    // **gap 허용해를 흉내 낸다** — 진짜 풀이의 목표값만 3% 깎는다(5% gap 안쪽).
    let id = 0;
    const candidates: RaidPlannerCandidate[] = [];
    for (let member = 0; member < 5; member++) {
      for (let team = 0; team < 3; team++) candidates.push(candidate(id++, member, member, team));
    }
    const hp = Array.from({ length: 3 }, () => Array(5).fill(50 * RAID_DAMAGE_SCALE));
    const shaved = (model: string, options?: { budgetSeconds?: number }): MilpSolution => {
      const real = highs.solve(model, { output_flag: false, time_limit: options?.budgetSeconds ?? 10 });
      return { ...real, ObjectiveValue: real.ObjectiveValue * 0.97 };
    };

    // gap을 안 알려 주면(= 예전 동작) 1단계에서 멈춘다.
    expect(optimizeRaidPlan({ phases: hp, candidates }, shaved).reached).toBe('phase1');
    // 알려 주면 상계(z / (1 - gap))로 견주므로 계속 나아간다.
    expect(optimizeRaidPlan({ phases: hp, candidates }, shaved, undefined, 0.05).reached)
      .not.toBe('phase1');
  });

  it('spends only the small budget on the optional overkill pass', () => {
    // 꼬리 깎기는 시간이 다하면 직전 해로 되돌려지는, 있으면 좋고 없어도 그만인 판이다.
    // 큰 예산을 주면 그만큼 통째로 버려진다(32명 판 42초 중 30초).
    let id = 0;
    const candidates: RaidPlannerCandidate[] = [];
    for (let member = 0; member < 5; member++) {
      for (let team = 0; team < 3; team++) candidates.push(candidate(id++, member, member, team));
    }
    const hp = Array.from({ length: 3 }, () => Array(5).fill(50 * RAID_DAMAGE_SCALE));
    const budgets: Array<number | undefined> = [];
    const watched = (model: string, options?: { budgetSeconds?: number }): MilpSolution => {
      budgets.push(options?.budgetSeconds);
      return highs.solve(model, { output_flag: false, time_limit: options?.budgetSeconds ?? 10 });
    };

    optimizeRaidPlan({ phases: hp, candidates }, watched);

    // 마지막 한 판만 작은 예산을 받고, 그 앞의 단계 풀이들은 호출자 기본값을 쓴다.
    expect(budgets[budgets.length - 1]).toBe(TIE_BUDGET_SECONDS);
    expect(budgets.slice(0, -1).every(b => b === undefined)).toBe(true);
  });

  it('never leaves an attack idle when the endless boss is reachable', () => {
    // 무한 오왕은 혈량이 없어 한 발 더 쏘면 그만큼 점수가 는다. 그런데 풀이기가 시간
    // 제한에 걸리면 배정이 덜 된 채로 돌아오고, 그 남은 발이 버려졌다(2026-09-20:
    // 예산 5초에서 32명 중 두 명이 두 발만 받았다). 뒤에서 주워 담는지 본다.
    let id = 0;
    const candidates: RaidPlannerCandidate[] = [];
    for (let member = 0; member < 5; member++) {
      for (let team = 0; team < 3; team++) candidates.push(candidate(id++, member, member, team));
      // 5왕에 **서로 니케가 안 겹치는** 두 덱을 더 준다 — 두 발이 가능한 모양.
      for (let team = 3; team < 5; team++) candidates.push(candidate(id++, member, 4, team));
    }
    const hp = Array.from({ length: 3 }, () => Array(5).fill(50 * RAID_DAMAGE_SCALE));

    // 시간 제한에 걸려 **덜 배정된** 풀이를 흉내 낸다: 마지막 한 판의 선택을 하나 지운다.
    let calls = 0;
    const starved = (model: string, options?: { budgetSeconds?: number }): MilpSolution => {
      const real = highs.solve(model, { output_flag: false, time_limit: options?.budgetSeconds ?? 10 }) as MilpSolution;
      calls += 1;
      if (!options?.budgetSeconds) return real;   // 단계 풀이는 그대로
      const columns: MilpSolution['Columns'] = { ...real.Columns };
      const dropped = Object.keys(columns).find(name => (columns[name]?.Primal ?? 0) > 0.5);
      if (dropped) columns[dropped] = { ...columns[dropped], Primal: 0 };
      return { ...real, Columns: columns };
    };

    const plan = optimizeRaidPlan({ phases: hp, candidates }, starved);
    expect(calls).toBeGreaterThan(0);
    expect(plan.reached).toBe('endless');
    // 한 자리를 지웠어도 사람마다 쏠 수 있는 만큼 다 쏜다.
    expect(plan.plannedAttacks).toBe(plan.attackCapacity);
    // 주워 담은 것은 전부 무한 단계로 간다.
    expect(plan.bars.find(bar => bar.phase === 3)!.shots.length).toBeGreaterThan(0);
  });

  it('keeps the greedy fill inside the game rules', () => {
    // 주워 담더라도 «세 발»과 «같은 니케 두 번 금지»는 넘지 않는다.
    let id = 0;
    const candidates: RaidPlannerCandidate[] = [];
    for (let member = 0; member < 5; member++) {
      for (let team = 0; team < 3; team++) candidates.push(candidate(id++, member, member, team));
      for (let team = 3; team < 8; team++) candidates.push(candidate(id++, member, 4, team));
    }
    const hp = Array.from({ length: 3 }, () => Array(5).fill(50 * RAID_DAMAGE_SCALE));
    const plan = optimizeRaidPlan({ phases: hp, candidates }, solve);

    for (const member of plan.members) {
      expect(member.shots.length).toBeLessThanOrEqual(3);
      const names = member.shots.flatMap(shot => shot.squad);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('clears phases in order and sends only remaining legal attacks to endless boss 5', () => {
    let id = 0;
    const candidates: RaidPlannerCandidate[] = [];
    for (let member = 0; member < 5; member++) {
      for (let team = 0; team < 3; team++) candidates.push(candidate(id++, member, member, team));
    }
    for (let team = 0; team < 3; team++) candidates.push(candidate(id++, 5, 4, team));
    const hp = Array.from({ length: 3 }, () => Array(5).fill(50 * RAID_DAMAGE_SCALE));
    const plan = optimizeRaidPlan({ phases: hp, candidates }, solve);

    expect(plan.reached).toBe('endless');
    expect(plan.provenOptimal).toBe(true);
    expect(plan.attackCapacity).toBe(18);
    expect(plan.bars.filter(bar => bar.phase < 3).every(bar => bar.cleared)).toBe(true);
    expect(plan.endlessDamage).toBe(180 * RAID_DAMAGE_SCALE);
    for (const member of plan.members) {
      const names = member.shots.flatMap(shot => shot.squad);
      expect(new Set(names).size).toBe(names.length);
      expect(member.shots.length).toBeLessThanOrEqual(3);
    }
  }, 30_000);

  it('respects alreadyUsed to cap a member below the normal three attacks', () => {
    const a = candidate(0, 0, 0, 0);
    const b = candidate(1, 0, 1, 1);
    const c = candidate(2, 0, 2, 2);
    const hp = Array.from({ length: 3 }, () => Array(5).fill(500 * RAID_DAMAGE_SCALE));
    const plan = optimizeRaidPlan({ phases: hp, candidates: [a, b, c], alreadyUsed: { m0: 2 } }, solve);
    const member = plan.members.find(m => m.memberId === 'm0')!;
    expect(member.capacity).toBe(1);
    expect(member.shots.length).toBeLessThanOrEqual(1);
  }, 30_000);

  it('drops a member to zero remaining attacks once alreadyUsed reaches three', () => {
    const a = candidate(0, 0, 0, 0);
    const hp = Array.from({ length: 3 }, () => Array(5).fill(500 * RAID_DAMAGE_SCALE));
    const plan = optimizeRaidPlan({ phases: hp, candidates: [a], alreadyUsed: { m0: 3 } }, solve);
    const member = plan.members.find(m => m.memberId === 'm0');
    expect(member?.capacity ?? 0).toBe(0);
    expect(member?.shots.length ?? 0).toBe(0);
  }, 30_000);

  it('does not assign attacks to a locked later phase when phase one cannot clear', () => {
    const candidates = Array.from({ length: 5 }, (_, boss) => candidate(boss, boss, boss, 0));
    const hp = Array.from({ length: 3 }, () => Array(5).fill(50 * RAID_DAMAGE_SCALE));
    hp[0]![0] = 500 * RAID_DAMAGE_SCALE;
    const plan = optimizeRaidPlan({ phases: hp, candidates }, solve);
    expect(plan.reached).toBe('phase1');
    expect(plan.bars.flatMap(bar => bar.shots).every(shot => shot.phase === 0)).toBe(true);
    expect(plan.bars.find(bar => bar.phase === 0 && bar.bossIndex === 0)?.cleared).toBe(false);
  }, 30_000);

  it('combines damage from multiple members attacking the same boss', () => {
    let id = 0;
    const candidates = [
      candidate(id++, 0, 0, 0, 60),
      candidate(id++, 1, 0, 0, 60),
      candidate(id++, 2, 1, 0, 60),
      candidate(id++, 3, 2, 0, 60),
      candidate(id++, 4, 3, 0, 60),
      candidate(id++, 5, 4, 0, 60),
    ];
    const hp = Array.from({ length: 3 }, () => Array(5).fill(500 * RAID_DAMAGE_SCALE));
    hp[0] = [100, 50, 50, 50, 50].map(value => value * RAID_DAMAGE_SCALE);

    const plan = optimizeRaidPlan({ phases: hp, candidates }, solve);
    const boss0 = plan.bars.find(bar => bar.phase === 0 && bar.bossIndex === 0)!;

    expect(boss0.cleared).toBe(true);
    expect(boss0.shots).toHaveLength(2);
    expect(plan.reached).toBe('phase2');
  }, 30_000);
});

