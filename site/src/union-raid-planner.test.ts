import { beforeAll, describe, expect, it } from 'vitest';
import loadHighs, { type Highs } from 'highs';
import {
  RAID_DAMAGE_SCALE, memberAttackCapacity, optimizeRaidPlan, type MilpSolution,
  type RaidPlannerCandidate,
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
  it('counts zero to three usable attacks from actual conflict-free candidates', () => {
    const a = candidate(0, 0, 0, 0);
    const b = candidate(1, 0, 1, 1);
    expect(memberAttackCapacity([a, b])).toBe(2);
    expect(memberAttackCapacity([a, { ...b, squad: [...a.squad] }])).toBe(1);
    expect(memberAttackCapacity([])).toBe(0);
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

