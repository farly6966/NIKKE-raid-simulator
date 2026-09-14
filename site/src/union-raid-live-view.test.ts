// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountLiveRaid } from './union-raid-live-view';
import { RAID_DAMAGE_SCALE, type RaidPlannerCandidate, type RaidPlannerInput, type RaidPlannerPlan } from './union-raid-planner';

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(): void {}
  terminate(): void {}
  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const candidate: RaidPlannerCandidate = {
  id: 0,
  memberId: 'm0',
  memberName: '測試成員',
  synchro: 700,
  bossIndex: 0,
  bossName: '一王',
  deckIndex: 0,
  squad: ['角色A', '角色B', '角色C', '角色D', '角色E'],
  damage: 60 * RAID_DAMAGE_SCALE,
};

const base: RaidPlannerInput = {
  phases: Array.from({ length: 3 }, () => Array(5).fill(300 * RAID_DAMAGE_SCALE)),
  candidates: [candidate],
};

const plan = (cleared: boolean): RaidPlannerPlan => ({
  status: 'Optimal',
  provenOptimal: true,
  reached: 'phase1',
  candidateMembers: 1,
  attackCapacity: 1,
  plannedAttacks: 1,
  totalFiniteHp: 4_500 * RAID_DAMAGE_SCALE,
  effectiveFiniteDamage: 60 * RAID_DAMAGE_SCALE,
  endlessDamage: 0,
  members: [{ memberId: candidate.memberId, memberName: candidate.memberName, synchro: candidate.synchro,
    capacity: 1, shots: [{ ...candidate, phase: 0, effectiveDamage: candidate.damage, remainingAfter: cleared ? 0 : 240 * RAID_DAMAGE_SCALE }] }],
  bars: [{
    phase: 0,
    bossIndex: 0,
    hp: 300 * RAID_DAMAGE_SCALE,
    rawDamage: candidate.damage,
    effectiveDamage: candidate.damage,
    remaining: cleared ? 0 : 240 * RAID_DAMAGE_SCALE,
    cleared,
    shots: [{ ...candidate, phase: 0, effectiveDamage: candidate.damage, remainingAfter: cleared ? 0 : 240 * RAID_DAMAGE_SCALE }],
  }],
});

function host(): HTMLElement {
  const panel = document.createElement('section');
  panel.innerHTML = `
    <div data-live-import><input data-live-file type="file"><div data-live-drop></div><span data-live-import-status></span></div>
    <div data-live-board><div data-live-status></div><div data-live-phases></div><div data-live-summary></div><div data-live-recorder></div><div data-live-overview></div><div data-live-bosses></div>
      <button data-live-reimport></button><button data-live-reset></button></div>`;
  document.body.append(panel);
  return panel;
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  localStorage.setItem('nikke-live-raid-base-v1', JSON.stringify(base));
  localStorage.setItem('nikke-live-raid-fired-v1', '[]');
});

describe('live raid confirmed-state rendering', () => {
  it('restores the recorder immediately without waiting for the optimizer', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });

    expect(panel.querySelector('.live-recorder-card')).not.toBeNull();
    expect(panel.textContent).toContain('第 1 階段');
    expect(panel.textContent).toContain('帳面剩餘刀');
  });

  it('does not jump to the furthest theoretically reachable phase after import', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: { ...plan(false), reached: 'phase3' } });

    const chips = [...panel.querySelectorAll('.live-phase-chip')];
    expect(chips[0]!.classList.contains('is-now')).toBe(true);
    expect(chips[2]!.classList.contains('is-now')).toBe(false);
    expect(panel.querySelector('.live-recorder-card')).not.toBeNull();
  });

  it('lets the operator record a shot from the always-visible manual form', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: plan(false) });

    panel.querySelector<HTMLButtonElement>('.live-recorder-card button')!.click();
    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!) as unknown[];
    expect(fired).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('does not show a boss as cleared before any planned attack is confirmed', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: plan(true) });

    const details = panel.querySelector<HTMLDetailsElement>('.live-boss-block')!;
    expect(details.open).toBe(true);
    expect(details.querySelector('summary')!.textContent).toContain('進行中');
    expect(details.querySelector('summary')!.textContent).toContain('0.3 億');
    expect(details.querySelector('summary')!.textContent).not.toContain('已清');
  });

  it('does not duplicate a confirmed shot when recalculation fails', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: plan(false) });

    panel.querySelector<HTMLButtonElement>('.live-shot-row.is-pending button')!.click();
    FakeWorker.instances[1]!.emit({ kind: 'error', message: '沒有可用的完整模擬結果。' });
    panel.querySelector<HTMLButtonElement>('.live-shot-row.is-pending button')?.click();

    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!) as unknown[];
    expect(fired).toHaveLength(1);
  });
});
