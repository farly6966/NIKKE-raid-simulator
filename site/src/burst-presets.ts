import { stepKey, type BurstCycle, type BurstSequence, type BurstStage, type BurstStep } from './burst-order';

/**
 * 특정 조합이 같은 편성에 있으면 커뮤니티가 이미 굳혀 둔 고정 개파 순서가 있다
 * (예: 크라운·마스트 : 로망틱 메이드가 함께 있으면 크라운-크라운-마스트로 돈다).
 * 엔진은 이 규칙을 모른다 — 손으로 「逐輪爆裂編輯」에 적는 것과 똑같은 `BurstSequence`를
 * 만들어 주는 지름길일 뿐이다. `requires`가 편성에 전부 있어야 후보로 뜨고,
 * 적용은 항상 사람이 단추를 눌러야 한다(자동으로 덮어쓰지 않는다).
 */
export interface BurstPreset {
  id: string;
  stage: BurstStage;
  /** 이 이름들이 편성에 전부 있어야 후보로 뜬다. 순서는 상관없다. */
  requires: string[];
  /** 반복되는 개파 순서. `stage` 칸에만 채운다. */
  pattern: string[];
}

export const BURST_PRESETS: BurstPreset[] = [
  {
    id: 'crown-mast-romantic-maid',
    stage: '2',
    requires: ['크라운', '마스트 : 로망틱 메이드'],
    pattern: ['크라운', '크라운', '마스트 : 로망틱 메이드'],
  },
  {
    id: 'flora-crown',
    stage: '2',
    requires: ['플로라', '크라운'],
    pattern: ['플로라', '크라운'],
  },
];

/** 이 편성에 맞는 프리셋들. 빈 칸은 무시한다. */
export function matchingPresets(squad: string[]): BurstPreset[] {
  const present = new Set(squad.map((name) => (name ?? '').trim()).filter(Boolean));
  return BURST_PRESETS.filter((preset) => preset.requires.every((name) => present.has(name)));
}

/** 사이클 수만큼 패턴을 이어 붙인 picks(걸음키 → 이름). 해당 단계만 채운다 — 다른 단계는 손대지 않는다. */
export function presetPicks(preset: BurstPreset, cycles: number): Record<string, string> {
  const picks: Record<string, string> = {};
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const step: BurstStep = { cycle, stage: preset.stage };
    picks[stepKey(step)] = preset.pattern[(cycle - 1) % preset.pattern.length]!;
  }
  return picks;
}

/**
 * `BurstSequence` 배열형(유니온 편집기용)으로 편다. `base`를 넘기면 그 사이클의
 * 다른 단계(B1·B3 등)는 그대로 두고 `stage` 칸만 패턴으로 덮어쓴다.
 */
export function presetSequence(preset: BurstPreset, cycles: number, base?: BurstSequence): BurstSequence {
  return Array.from({ length: Math.max(1, cycles) }, (_, i) => {
    const existing = base?.[i];
    const cycle: BurstCycle = {
      1: [...(existing?.[1] ?? [])],
      2: [...(existing?.[2] ?? [])],
      3: [...(existing?.[3] ?? [])],
    };
    cycle[preset.stage] = [preset.pattern[i % preset.pattern.length]!];
    return cycle;
  });
}
