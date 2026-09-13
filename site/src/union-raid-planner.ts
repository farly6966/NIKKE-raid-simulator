import type { JobResult } from './union-raid';

export const RAID_DAMAGE_SCALE = 100_000;

export interface RaidHealthInput {
  /** Three phases, each containing boss 1..5 HP in raw damage units. */
  phases: number[][];
}

export interface RaidPlannerCandidate {
  id: number;
  memberId: string;
  memberName: string;
  synchro: number;
  bossIndex: number;
  bossName: string;
  deckIndex: number;
  squad: string[];
  damage: number;
}

export interface RaidPlannerInput extends RaidHealthInput {
  candidates: RaidPlannerCandidate[];
}

export interface RaidPlannerShot extends RaidPlannerCandidate {
  /** 0..2 are finite phases; 3 is endless boss 5. */
  phase: number;
  effectiveDamage: number;
  remainingAfter: number | null;
}

export interface RaidPlannerBar {
  phase: number;
  bossIndex: number;
  hp: number | null;
  rawDamage: number;
  effectiveDamage: number;
  remaining: number | null;
  cleared: boolean;
  shots: RaidPlannerShot[];
}

export interface RaidPlannerMember {
  memberId: string;
  memberName: string;
  synchro: number;
  capacity: number;
  shots: RaidPlannerShot[];
}

export interface RaidPlannerPlan {
  status: string;
  provenOptimal: boolean;
  reached: 'phase1' | 'phase2' | 'phase3' | 'endless';
  candidateMembers: number;
  attackCapacity: number;
  plannedAttacks: number;
  bars: RaidPlannerBar[];
  members: RaidPlannerMember[];
  totalFiniteHp: number;
  effectiveFiniteDamage: number;
  endlessDamage: number;
}

export interface MilpColumn { Index?: number; Primal?: number }
export interface MilpSolution {
  Status: string;
  ObjectiveValue: number;
  Columns: Record<string, MilpColumn>;
}
export type MilpSolve = (model: string) => MilpSolution;

interface ModelSpec {
  text: string;
  variables: Array<{ name: string; candidate: number; phase: number }>;
}

const scaledDamage = (value: number): number => Math.floor(value / RAID_DAMAGE_SCALE);
const scaledHp = (value: number): number => Math.ceil(value / RAID_DAMAGE_SCALE);

const sum = (terms: string[]): string => terms.length ? terms.join(' + ') : '0';

function validCandidate(candidate: RaidPlannerCandidate): boolean {
  return Number.isFinite(candidate.damage) && candidate.damage > 0
    && candidate.bossIndex >= 0 && candidate.bossIndex < 5
    && candidate.squad.length === 5 && new Set(candidate.squad).size === 5;
}

function disjoint(a: RaidPlannerCandidate, b: RaidPlannerCandidate): boolean {
  const names = new Set(a.squad);
  return !b.squad.some(name => names.has(name));
}

/** Maximum usable attacks for one member, capped at the in-game three attacks. */
export function memberAttackCapacity(candidates: RaidPlannerCandidate[]): number {
  if (candidates.length === 0) return 0;
  let best = 1;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (!disjoint(candidates[i]!, candidates[j]!)) continue;
      best = 2;
      for (let k = j + 1; k < candidates.length; k++) {
        if (disjoint(candidates[i]!, candidates[k]!) && disjoint(candidates[j]!, candidates[k]!)) return 3;
      }
    }
  }
  return best;
}

export function plannerCandidates(results: JobResult[]): RaidPlannerCandidate[] {
  return results.flatMap((row, id) => {
    if (row.damage === undefined) return [];
    const candidate: RaidPlannerCandidate = {
      id,
      memberId: row.job.member.openid,
      memberName: row.job.member.name,
      synchro: row.job.member.synchro,
      bossIndex: row.job.bossIndex,
      bossName: row.job.bossName,
      deckIndex: row.job.deckIndex,
      squad: row.job.squad.filter(Boolean),
      damage: row.damage,
    };
    return validCandidate(candidate) ? [candidate] : [];
  });
}

function validate(input: RaidPlannerInput): RaidPlannerCandidate[] {
  if (input.phases.length !== 3 || input.phases.some(phase => phase.length !== 5)) {
    throw new Error('必須提供三階段、每階段五隻 Boss 的血量。');
  }
  if (input.phases.flat().some(hp => !Number.isFinite(hp) || hp <= 0)) {
    throw new Error('Boss 血量必須是大於 0 的數字。');
  }
  const candidates = input.candidates.filter(validCandidate);
  if (!candidates.length) throw new Error('沒有可用的完整模擬結果。');
  return candidates;
}

function buildModel(
  input: RaidPlannerInput,
  candidates: RaidPlannerCandidate[],
  targetPhase: number,
  mode: 'maximize' | 'tie',
  fixedObjective = 0,
): ModelSpec {
  const finiteTarget = targetPhase < 3;
  const variables: ModelSpec['variables'] = [];
  for (let candidate = 0; candidate < candidates.length; candidate++) {
    for (let phase = 0; phase <= Math.min(targetPhase, 2); phase++) {
      variables.push({ name: `x_${candidate}_${phase}`, candidate, phase });
    }
    if (targetPhase === 3 && candidates[candidate]!.bossIndex === 4) {
      variables.push({ name: `x_${candidate}_3`, candidate, phase: 3 });
    }
  }
  const byMember = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const list = byMember.get(candidate.memberId) ?? [];
    list.push(index); byMember.set(candidate.memberId, list);
  });
  const varsFor = (candidateIndex: number, phase?: number): string[] => variables
    .filter(variable => variable.candidate === candidateIndex && (phase === undefined || variable.phase === phase))
    .map(variable => variable.name);
  const damageTerms = (phase: number, boss: number): string[] => variables
    .filter(variable => variable.phase === phase && candidates[variable.candidate]!.bossIndex === boss)
    .map(variable => `${scaledDamage(candidates[variable.candidate]!.damage)} ${variable.name}`);

  const objectiveTerms = finiteTarget
    ? Array.from({ length: 5 }, (_, boss) => `y_${boss}`)
    : damageTerms(3, 4);
  const finiteRaw = variables.filter(variable => variable.phase < 3)
    .map(variable => `${scaledDamage(candidates[variable.candidate]!.damage)} ${variable.name}`);
  const lines = [mode === 'maximize' ? 'Maximize' : 'Minimize',
    ` objective: ${sum(mode === 'maximize' ? objectiveTerms : finiteRaw)}`, 'Subject To'];

  let row = 0;
  for (const [memberId, indices] of byMember) {
    const memberVars = indices.flatMap(index => varsFor(index));
    lines.push(` member_${row++}: ${sum(memberVars)} <= 3`);
    for (const index of indices) lines.push(` candidate_${index}: ${sum(varsFor(index))} <= 1`);
    const characters = [...new Set(indices.flatMap(index => candidates[index]!.squad))];
    for (const character of characters) {
      const conflict = indices.filter(index => candidates[index]!.squad.includes(character)).flatMap(index => varsFor(index));
      lines.push(` character_${row++}: ${sum(conflict)} <= 1`);
    }
    void memberId;
  }

  const requiredFinitePhases = finiteTarget ? targetPhase : 3;
  for (let phase = 0; phase < requiredFinitePhases; phase++) {
    for (let boss = 0; boss < 5; boss++) {
      lines.push(` clear_${phase}_${boss}: ${sum(damageTerms(phase, boss))} >= ${scaledHp(input.phases[phase]![boss]!)}`);
    }
  }
  if (finiteTarget) {
    for (let boss = 0; boss < 5; boss++) {
      const hp = scaledHp(input.phases[targetPhase]![boss]!);
      lines.push(` effective_damage_${boss}: y_${boss} - ${sum(damageTerms(targetPhase, boss))} <= 0`);
      lines.push(` effective_cap_${boss}: y_${boss} <= ${hp}`);
    }
    if (mode === 'tie') lines.push(` keep_objective: ${sum(objectiveTerms)} >= ${Math.floor(fixedObjective + 0.5)}`);
  } else if (mode === 'tie') {
    lines.push(` keep_objective: ${sum(objectiveTerms)} >= ${Math.floor(fixedObjective + 0.5)}`);
  }

  if (finiteTarget) {
    lines.push('Bounds');
    for (let boss = 0; boss < 5; boss++) lines.push(` 0 <= y_${boss} <= ${scaledHp(input.phases[targetPhase]![boss]!)}`);
  }
  lines.push('Binaries', ...variables.map(variable => ` ${variable.name}`), 'End');
  return { text: lines.join('\n'), variables };
}

function usable(solution: MilpSolution): boolean {
  return solution.Status === 'Optimal'
    || (solution.Status === 'Time limit reached' && Object.keys(solution.Columns ?? {}).length > 0);
}

function selectedFrom(spec: ModelSpec, solution: MilpSolution): Array<{ candidate: number; phase: number }> {
  return spec.variables.filter(variable => (solution.Columns[variable.name]?.Primal ?? 0) > 0.5)
    .map(({ candidate, phase }) => ({ candidate, phase }));
}

/**
 * Solve phase by phase. A later phase is considered only after HiGHS proves all five bars in the
 * previous phase clearable. The final tie solve minimizes finite overkill without changing progress.
 */
export function optimizeRaidPlan(
  input: RaidPlannerInput,
  solve: MilpSolve,
  onProgress?: (message: string) => void,
): RaidPlannerPlan {
  const candidates = validate(input);
  let targetPhase = 0;
  let primarySpec!: ModelSpec;
  let primary!: MilpSolution;
  let provenOptimal = true;
  for (let phase = 0; phase < 3; phase++) {
    onProgress?.(`正在求解第 ${phase + 1} 階段…`);
    const spec = buildModel(input, candidates, phase, 'maximize');
    const solution = solve(spec.text);
    if (!usable(solution)) throw new Error(`最佳化失敗：${solution.Status}`);
    primarySpec = spec; primary = solution; targetPhase = phase;
    if (solution.Status !== 'Optimal') { provenOptimal = false; break; }
    const required = input.phases[phase]!.reduce((total, hp) => total + scaledHp(hp), 0);
    if (solution.ObjectiveValue < required - 0.5) break;
    if (phase === 2) {
      onProgress?.('三階段可全清，正在最佳化無限五王傷害…');
      primarySpec = buildModel(input, candidates, 3, 'maximize');
      primary = solve(primarySpec.text); targetPhase = 3;
      if (!usable(primary)) throw new Error(`無限階段最佳化失敗：${primary.Status}`);
      if (primary.Status !== 'Optimal') provenOptimal = false;
    }
  }

  onProgress?.('正在減少尾刀溢傷…');
  const tieSpec = buildModel(input, candidates, targetPhase, 'tie', primary.ObjectiveValue);
  const tie = solve(tieSpec.text);
  const finalSpec = tie.Status === 'Optimal' ? tieSpec : primarySpec;
  const final = tie.Status === 'Optimal' ? tie : primary;
  if (tie.Status !== 'Optimal') provenOptimal = false;
  const picked = selectedFrom(finalSpec, final);

  const bars: RaidPlannerBar[] = [];
  for (let phase = 0; phase < 3; phase++) {
    for (let boss = 0; boss < 5; boss++) {
      const hp = input.phases[phase]![boss]!;
      const rows = picked.filter(item => item.phase === phase && candidates[item.candidate]!.bossIndex === boss)
        .map(item => candidates[item.candidate]!).sort((a, b) => a.damage - b.damage || a.memberName.localeCompare(b.memberName));
      let remaining = hp;
      const shots = rows.map(candidate => {
        const effectiveDamage = Math.min(candidate.damage, remaining);
        remaining = Math.max(0, remaining - candidate.damage);
        return { ...candidate, phase, effectiveDamage, remainingAfter: remaining };
      });
      const rawDamage = rows.reduce((total, candidate) => total + candidate.damage, 0);
      bars.push({ phase, bossIndex: boss, hp, rawDamage, effectiveDamage: Math.min(rawDamage, hp),
        remaining, cleared: remaining === 0, shots });
    }
  }
  if (targetPhase === 3) {
    const rows = picked.filter(item => item.phase === 3).map(item => candidates[item.candidate]!)
      .sort((a, b) => b.damage - a.damage || a.memberName.localeCompare(b.memberName));
    const shots = rows.map(candidate => ({ ...candidate, phase: 3, effectiveDamage: candidate.damage, remainingAfter: null }));
    const rawDamage = rows.reduce((total, candidate) => total + candidate.damage, 0);
    bars.push({ phase: 3, bossIndex: 4, hp: null, rawDamage, effectiveDamage: rawDamage,
      remaining: null, cleared: false, shots });
  }

  const memberGroups = new Map<string, RaidPlannerCandidate[]>();
  for (const candidate of candidates) {
    const list = memberGroups.get(candidate.memberId) ?? [];
    list.push(candidate); memberGroups.set(candidate.memberId, list);
  }
  const allShots = bars.flatMap(bar => bar.shots);
  const members: RaidPlannerMember[] = [...memberGroups.entries()].map(([memberId, rows]) => ({
    memberId, memberName: rows[0]!.memberName, synchro: rows[0]!.synchro,
    capacity: memberAttackCapacity(rows),
    shots: allShots.filter(shot => shot.memberId === memberId).sort((a, b) => a.phase - b.phase || a.bossIndex - b.bossIndex),
  })).sort((a, b) => a.memberName.localeCompare(b.memberName));
  const finiteBars = bars.filter(bar => bar.phase < 3);
  const totalFiniteHp = input.phases.flat().reduce((total, hp) => total + hp, 0);
  const reached = targetPhase === 3 ? 'endless' : (`phase${targetPhase + 1}` as RaidPlannerPlan['reached']);
  return {
    status: final.Status, provenOptimal, reached, candidateMembers: members.length,
    attackCapacity: members.reduce((total, member) => total + member.capacity, 0),
    plannedAttacks: allShots.length, bars, members, totalFiniteHp,
    effectiveFiniteDamage: finiteBars.reduce((total, bar) => total + bar.effectiveDamage, 0),
    endlessDamage: bars.find(bar => bar.phase === 3)?.rawDamage ?? 0,
  };
}
