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
  input?: RaidPlannerInput;
  postMessage(input: RaidPlannerInput): void { this.input = input; }
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
    <div data-live-board><div data-live-status></div><div data-live-phases></div><div data-live-summary></div><div data-live-members></div><div data-live-recorder></div><div data-live-overview></div><div data-live-bosses></div>
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

describe('optional calibration lifecycle', () => {
  const calibrationKey = 'nikke-live-raid-calibration-v1';
  const clickText = (panel: HTMLElement, text: string): void => {
    const button = [...panel.querySelectorAll('button')].find(b => b.textContent === text);
    expect(button, text).toBeDefined(); button!.click();
  };
  const setup = (enabled = true, factors: Record<string, number> = {}): HTMLElement => {
    localStorage.setItem(calibrationKey, JSON.stringify({ enabled, factors }));
    const panel = host(); mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances.at(-1)!.emit({ kind: 'done', plan: plan(false) });
    return panel;
  };
  const seedTrend = (): void => {
    localStorage.setItem('nikke-live-raid-fired-v1', JSON.stringify(Array.from({ length: 5 }, (_, i) => ({
      ...candidate, memberId: `past-${i}`, squad: [], phase: 0,
      damage: 0.9 * candidate.damage, simulatedDamage: candidate.damage,
      predictedDamage: candidate.damage, calibrationSample: 'verified', finishingShot: false,
    }))));
  };

  it('defaults off and restores a disabled saved state without applying its factors', () => {
    const panel = host(); mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: n => n });
    expect(panel.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
    expect(FakeWorker.instances.at(-1)!.input!.candidates[0]!.damage).toBe(candidate.damage);
    const disabled = setup(false, { 0: 0.9 });
    expect(disabled.textContent).toContain('目前關閉');
    expect(FakeWorker.instances.at(-1)!.input!.candidates[0]!.damage).toBe(candidate.damage);
  });

  it('uses calibrated estimates in manual and pending forms, retaining both snapshots', () => {
    const panel = setup(true, { 0: 0.5 });
    expect(FakeWorker.instances.at(-1)!.input!.candidates[0]!.damage).toBe(candidate.damage * 0.5);
    expect(panel.querySelector<HTMLInputElement>('.live-recorder-card .live-damage-input')!.value).toBe('0.03');
    expect(panel.querySelector<HTMLInputElement>('.live-shot-row.is-pending .live-damage-input')!.value).toBe('0.03');
    const card = panel.querySelector<HTMLElement>('.live-recorder-card')!;
    card.querySelector<HTMLInputElement>('.live-sample-verification input')!.checked = true;
    card.querySelector<HTMLButtonElement>('.live-recorder-controls button')!.click();
    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!);
    expect(fired[0]).toMatchObject({ simulatedDamage: candidate.damage, predictedDamage: candidate.damage * 0.5,
      calibrationSample: 'verified', finishingShot: false });
    expect(JSON.parse(localStorage.getItem('nikke-live-raid-base-v1')!).candidates[0].damage).toBe(candidate.damage);
  });

  it('never includes an untouched prefilled value but accepts an explicitly verified complete finisher', () => {
    let panel = setup();
    panel.querySelector<HTMLButtonElement>('.live-quick-confirm button')!.click();
    expect(JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!)[0].calibrationSample).toBe('unreviewed');
    localStorage.setItem('nikke-live-raid-fired-v1', '[]');
    panel = setup();
    const quick = panel.querySelector<HTMLElement>('.live-quick-confirm')!;
    quick.querySelector<HTMLInputElement>('.live-damage-input')!.value = '0.3';
    quick.querySelector<HTMLInputElement>('.live-sample-verification input')!.checked = true;
    quick.querySelector<HTMLButtonElement>('button')!.click();
    expect(JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!)[0]).toMatchObject({
      finishingShot: true, finishingReviewed: true, calibrationSample: 'verified',
    });
    expect(panel.querySelector<HTMLSelectElement>('.live-calibration-sample select')!.disabled).toBe(false);
    expect(panel.textContent).toContain('完整收尾刀：納入分析');
    expect(panel.textContent).toContain('有效樣本 1 刀');
  });

  it('asks for finisher classification and supports reversible full-output and overflow decisions', () => {
    seedTrend(); const panel = setup();
    panel.querySelector<HTMLButtonElement>('.live-quick-confirm button')!.click();
    expect(panel.textContent).toContain('1 筆收尾待確認');
    expect(panel.textContent).toContain('有效樣本 5 刀');
    expect(panel.querySelector<HTMLDetailsElement>('.live-calibration > details')!.open).toBe(true);
    const selectStatus = (value: string): void => {
      const select = panel.querySelector<HTMLSelectElement>('[aria-label="第 6 刀樣本狀態"]')!;
      expect(select.disabled).toBe(false);
      select.value = value; select.dispatchEvent(new Event('change'));
    };
    const workers = FakeWorker.instances.length;
    selectStatus('verified');
    expect(panel.textContent).toContain('有效樣本 6 刀');
    expect(panel.textContent).toContain('完整收尾刀：納入分析');
    selectStatus('overflow');
    expect(panel.textContent).toContain('有效樣本 5 刀');
    expect(panel.textContent).toContain('已確認溢出尾刀：排除');
    const saved = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!)[5];
    expect(saved).toMatchObject({ calibrationSample: 'overflow', finishingReviewed: true });
    const restored = setup();
    expect(restored.querySelector<HTMLSelectElement>('[aria-label="第 6 刀樣本狀態"]')!.value).toBe('overflow');
    selectStatus('verified');
    expect(panel.textContent).toContain('有效樣本 6 刀');
    expect(FakeWorker.instances).toHaveLength(workers + 1);
  });

  it('restores a legacy auto-excluded finisher as pending instead of silently including it', () => {
    seedTrend();
    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!);
    fired[0].finishingShot = true;
    localStorage.setItem('nikke-live-raid-fired-v1', JSON.stringify(fired));
    const panel = setup();
    expect(panel.textContent).toContain('有效樣本 4 刀');
    expect(panel.textContent).toContain('1 筆收尾待確認');
    const select = panel.querySelector<HTMLSelectElement>('[aria-label="第 1 刀樣本狀態"]')!;
    expect(select.value).toBe('unreviewed');
    select.value = 'verified'; select.dispatchEvent(new Event('change'));
    expect(panel.textContent).toContain('有效樣本 5 刀');
  });

  it('previews without mutation, applies only on confirmation and discards factors when disabled', () => {
    seedTrend(); const panel = setup();
    clickText(panel, '預覽校正與重排');
    expect(FakeWorker.instances.at(-1)!.input!.candidates[0]!.damage).toBe(candidate.damage * 0.9);
    expect(JSON.parse(localStorage.getItem(calibrationKey)!).factors).toEqual({});
    FakeWorker.instances.at(-1)!.emit({ kind: 'done', plan: plan(false) });
    expect(panel.textContent).toContain('尚未套用');
    clickText(panel, '確認套用校正');
    expect(JSON.parse(localStorage.getItem(calibrationKey)!).factors).toEqual({ 0: 0.9 });
    panel.querySelector<HTMLInputElement>('[role="switch"]')!.click();
    expect(JSON.parse(localStorage.getItem(calibrationKey)!)).toEqual({ enabled: false, factors: {} });
    expect(FakeWorker.instances.at(-1)!.input!.candidates[0]!.damage).toBe(candidate.damage);
    panel.querySelector<HTMLInputElement>('[role="switch"]')!.click();
    expect(JSON.parse(localStorage.getItem(calibrationKey)!)).toEqual({ enabled: true, factors: {} });
  });

  it('cancels stale preview results when a new shot is recorded', () => {
    seedTrend(); const panel = setup();
    clickText(panel, '預覽校正與重排'); const oldPreview = FakeWorker.instances.at(-1)!;
    panel.querySelector<HTMLButtonElement>('.live-quick-confirm button')!.click();
    oldPreview.emit({ kind: 'done', plan: plan(false) });
    expect(panel.querySelector('.live-calibration-preview')).toBeNull();
    expect(JSON.parse(localStorage.getItem(calibrationKey)!).factors).toEqual({});
  });

  it('keeps current factors and plan when preview fails or is cancelled', () => {
    seedTrend(); const panel = setup();
    clickText(panel, '預覽校正與重排');
    FakeWorker.instances.at(-1)!.emit({ kind: 'error', message: 'test error' });
    expect(panel.textContent).toContain('校正預覽失敗');
    expect(panel.querySelector('.live-quick-confirm')).not.toBeNull();
    clickText(panel, '預覽校正與重排');
    FakeWorker.instances.at(-1)!.emit({ kind: 'done', plan: plan(false) });
    clickText(panel, '取消');
    expect(panel.querySelector('.live-calibration-preview')).toBeNull();
    expect(JSON.parse(localStorage.getItem(calibrationKey)!).factors).toEqual({});
  });

  it('invalidates previews after sample review without rerunning the current optimizer', () => {
    seedTrend(); const panel = setup();
    clickText(panel, '預覽校正與重排'); const oldPreview = FakeWorker.instances.at(-1)!;
    const count = FakeWorker.instances.length;
    const select = panel.querySelector<HTMLSelectElement>('.live-calibration-sample select')!;
    select.value = 'abnormal'; select.dispatchEvent(new Event('change'));
    oldPreview.emit({ kind: 'done', plan: plan(false) });
    expect(panel.querySelector('.live-calibration-preview')).toBeNull();
    expect(FakeWorker.instances).toHaveLength(count);
    expect(panel.textContent).toContain('有效樣本 4 刀');
  });

  it('clears calibration on reset and reimport, but preserves historical shot snapshots on undo calibration', () => {
    const panel = setup(true, { 0: 0.9 });
    clickText(panel, '撤銷此王校正');
    expect(FakeWorker.instances.at(-1)!.input!.candidates[0]!.damage).toBe(candidate.damage);
    panel.querySelector<HTMLButtonElement>('[data-live-reset]')!.click();
    expect(JSON.parse(localStorage.getItem(calibrationKey)!)).toEqual({ enabled: false, factors: {} });
    panel.querySelector<HTMLInputElement>('[role="switch"]')!.click();
    const event = new Event('drop');
    Object.defineProperty(event, 'dataTransfer', { value: { files: [{ text: () => Promise.resolve(JSON.stringify(base)) }] } });
    panel.querySelector('[data-live-drop]')!.dispatchEvent(event);
    return Promise.resolve().then(() => {
      expect(JSON.parse(localStorage.getItem(calibrationKey)!)).toEqual({ enabled: false, factors: {} });
    });
  });
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

  it('shows portraits and team names instead of T1/T2 codes', () => {
    const named = { ...candidate, deckLabel: '紅蓮速攻' };
    localStorage.setItem('nikke-live-raid-base-v1', JSON.stringify({ ...base, candidates: [named] }));
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: name => `/img/${name}.webp`, labelOf: name => name });
    const planned = plan(false);
    planned.bars[0]!.shots[0]!.deckLabel = '紅蓮速攻';
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: planned });

    expect(panel.textContent).not.toMatch(/T1|B1-T1/);
    expect(panel.querySelector('.live-recommendation')!.textContent).toContain('紅蓮速攻');
    expect(panel.querySelectorAll('.live-recommendation img.share-portrait')).toHaveLength(5);
    const pending = panel.querySelector('.live-shot-row.is-pending')!;
    expect(pending.textContent).toContain('紅蓮速攻');
    expect(pending.querySelectorAll('img.share-portrait')).toHaveLength(5);
    // 只有一隊可選時不顯示「換隊伍」。
    expect(pending.querySelector('.live-team-swap')).toBeNull();
  });

  it('lets the player switch teams by clicking portraits and records the chosen team', () => {
    const second: RaidPlannerCandidate = {
      ...candidate, id: 1, deckIndex: 1, deckLabel: '水冷隊', damage: 45 * 100_000_000,
      squad: ['角色F', '角色G', '角色H', '角色I', '角色J'],
    };
    localStorage.setItem('nikke-live-raid-base-v1', JSON.stringify({ ...base, candidates: [candidate, second] }));
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: plan(false) });

    const pending = panel.querySelector<HTMLElement>('.live-shot-row.is-pending')!;
    const options = [...pending.querySelectorAll<HTMLButtonElement>('.live-team-swap .live-team-option')];
    expect(options).toHaveLength(2);
    expect(options[0]!.getAttribute('aria-checked')).toBe('true');
    expect(options[1]!.textContent).toContain('水冷隊');
    options[1]!.click();
    expect(options[1]!.getAttribute('aria-checked')).toBe('true');
    expect(pending.querySelector<HTMLInputElement>('.live-damage-input')!.value).toBe('45.00');
    expect(pending.querySelector('.live-shot-preview')!.textContent).toContain('水冷隊');

    pending.querySelector<HTMLButtonElement>(':scope > button')!.click();
    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!) as Array<{ deckIndex: number; deckLabel?: string }>;
    expect(fired).toEqual([expect.objectContaining({ deckIndex: 1, deckLabel: '水冷隊' })]);
  });

  it('makes the recorder follow the plan instead of the first candidate', () => {
    // 첫 줄(덱 0)이 아니라 **방안이 고른 덱 1**이 미리 잡혀야 한다. 예전에는 첫 줄을
    // 골라서, 그대로 확정하면 쏘지도 않은 편성이 기록되고 이후 배제가 어긋났다.
    const second: RaidPlannerCandidate = {
      ...candidate, id: 1, deckIndex: 1, deckLabel: '水冷隊', damage: 45 * 100_000_000,
      squad: ['角色F', '角色G', '角色H', '角色I', '角色J'],
    };
    localStorage.setItem('nikke-live-raid-base-v1', JSON.stringify({ ...base, candidates: [candidate, second] }));
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });

    const planned = plan(false);
    planned.bars[0]!.shots = [{ ...second, phase: 0, effectiveDamage: second.damage, remainingAfter: 0 }];
    planned.members[0]!.shots = [{ ...second, phase: 0, effectiveDamage: second.damage, remainingAfter: 0 }];
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: planned });

    const card = panel.querySelector<HTMLElement>('.live-recorder-card')!;
    expect(card.querySelector<HTMLInputElement>('.live-damage-input')!.value).toBe('45.00');
    const picked = card.querySelector<HTMLButtonElement>('.live-team-option[aria-checked="true"]')!;
    expect(picked.textContent).toContain('水冷隊');
    expect(picked.classList.contains('is-suggested')).toBe(true);
    expect(card.querySelector('select[aria-label="實際出刀成員"]')!.textContent).toContain('建議');

    card.querySelector<HTMLButtonElement>('.live-recorder-controls button')!.click();
    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!) as Array<{ deckIndex: number }>;
    expect(fired).toEqual([expect.objectContaining({ deckIndex: 1 })]);
  });

  it('confirms a shot straight from the top recommendation card', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: plan(false) });

    const quick = panel.querySelector<HTMLElement>('.live-recommendation .live-quick-confirm')!;
    expect(quick.querySelector<HTMLInputElement>('.live-damage-input')!.value)
      .toBe((candidate.damage / 100_000_000).toFixed(2));
    quick.querySelector<HTMLInputElement>('.live-damage-input')!.value = '58.5';
    quick.querySelector<HTMLButtonElement>('button')!.click();

    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!) as Array<{ damage: number }>;
    expect(fired).toEqual([expect.objectContaining({ damage: 58.5 * 100_000_000 })]);
  });

  it('rejects a quick confirm with no damage typed instead of recording a zero', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: plan(false) });

    const quick = panel.querySelector<HTMLElement>('.live-recommendation .live-quick-confirm')!;
    quick.querySelector<HTMLInputElement>('.live-damage-input')!.value = '';
    quick.querySelector<HTMLButtonElement>('button')!.click();

    expect(JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!)).toEqual([]);
    expect(panel.querySelector('[data-live-status]')!.textContent).toContain('大於 0');
  });

  it('shows every member their own three shots across phases, not just this one', () => {
    // 나머지 화면은 전부 «지금 단계»만 본다. 2·3단계에 잡힌 몫이 안 보이면
    // 그 사람은 화면에서 「0/3·할 일 없음」으로 보인다 — 실제로는 배정돼 있다.
    const later: RaidPlannerCandidate = {
      ...candidate, id: 1, bossIndex: 2, bossName: '三王', deckIndex: 1,
      squad: ['角色F', '角色G', '角色H', '角色I', '角色J'],
    };
    localStorage.setItem('nikke-live-raid-base-v1', JSON.stringify({ ...base, candidates: [candidate, later] }));
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });

    const planned = plan(false);
    planned.members[0]!.shots = [
      { ...candidate, phase: 0, effectiveDamage: candidate.damage, remainingAfter: 0 },
      { ...later, phase: 2, effectiveDamage: later.damage, remainingAfter: 0 },
    ];
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: planned });

    const card = panel.querySelector<HTMLElement>('.live-member-card')!;
    const lines = [...card.querySelectorAll('.live-member-shot')];
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain('1階');
    expect(lines[0]!.classList.contains('is-now')).toBe(true);
    expect(lines[1]!.textContent).toContain('3階');
    expect(lines[1]!.textContent).toContain('三王');
    expect(lines[1]!.classList.contains('is-now')).toBe(false);
  });

  it('marks a confirmed shot as done inside the member card', () => {
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });
    FakeWorker.instances[0]!.emit({ kind: 'done', plan: plan(false) });
    panel.querySelector<HTMLElement>('.live-recommendation .live-quick-confirm button')!.click();

    const card = panel.querySelector<HTMLElement>('.live-member-card')!;
    expect(card.textContent).toContain('1 / 3 已出');
    expect(card.querySelector('.live-member-shot.is-done')!.textContent).toContain('✓');
  });

  it('uses a portrait picker in the manual recorder too', () => {
    const second: RaidPlannerCandidate = {
      ...candidate, id: 1, deckIndex: 1, damage: 45 * RAID_DAMAGE_SCALE,
      squad: ['角色F', '角色G', '角色H', '角色I', '角色J'],
    };
    localStorage.setItem('nikke-live-raid-base-v1', JSON.stringify({ ...base, candidates: [candidate, second] }));
    const panel = host();
    mountLiveRaid({ panel }, { imageOf: () => undefined, labelOf: name => name });

    const card = panel.querySelector<HTMLElement>('.live-recorder-card')!;
    expect(card.querySelector('select[aria-label="實際使用隊伍"]')).toBeNull();
    const options = [...card.querySelectorAll<HTMLButtonElement>('.live-team-option')];
    expect(options).toHaveLength(2);
    options[1]!.click();
    card.querySelector<HTMLButtonElement>('.live-recorder-controls button')!.click();
    const fired = JSON.parse(localStorage.getItem('nikke-live-raid-fired-v1')!) as Array<{ deckIndex: number }>;
    expect(fired).toEqual([expect.objectContaining({ deckIndex: 1 })]);
  });
});
