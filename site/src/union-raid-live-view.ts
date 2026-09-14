import { squadPreview } from './share-panel';
import type { RaidPlannerInput, RaidPlannerPlan, RaidPlannerShot } from './union-raid-planner';
import {
  findCandidate, remainingCandidates, remainingPhases, usedCounts, type FiredShot,
} from './union-raid-live';

export interface LiveRaidHosts {
  panel: HTMLElement;
}

export interface LiveRaidDeps {
  imageOf: (name: string) => string | undefined;
  labelOf: (name: string) => string;
}

export type LiveRaidHandle = Record<string, never>;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const YI = 100_000_000;
const yi = (value: number): string => `${(value / YI).toLocaleString('zh-TW', {
  minimumFractionDigits: 0, maximumFractionDigits: 2,
})} 億`;

const BASE_KEY = 'nikke-live-raid-base-v1';
const FIRED_KEY = 'nikke-live-raid-fired-v1';

/** 대기 중인 한 발을 가리키는 열쇠 — 지난 방안과 견줘 자리가 바뀌었는지 볼 때 쓴다. */
const pendingKey = (shot: { phase: number; bossIndex: number; memberId: string; deckIndex: number }): string =>
  `${shot.phase}:${shot.bossIndex}:${shot.memberId}:${shot.deckIndex}`;

const PHASE_LABELS = ['第 1 階段', '第 2 階段', '第 3 階段', '無限五王'];

/** `plan.reached`을 화면이 초점 맞출 단계 번호로. 0~2는 유한 단계, 3은 무한 5왕. */
function currentPhaseIndex(plan: RaidPlannerPlan): number {
  if (plan.reached === 'endless') return 3;
  return { phase1: 0, phase2: 1, phase3: 2 }[plan.reached];
}

/**
 * 「실전 추연(BETA)」 — 미리 낸 시뮬레이션 결과를 불러와, 현장에서 확정되는 대로
 * 남은 문제를 계속 다시 푼다.
 *
 * 유니온 탭과는 일부러 분리한다 — 명단 가져오기·Boss 편성 같은 준비 단계가 전혀
 * 필요 없고, 조작하는 사람도 현장에서는 다른 사람일 수 있다(§AGENTS 대화 참고).
 * 그래서 입력은 JSON 파일 하나뿐이고, 여기서 나오는 상태는 이 브라우저에만 남는다.
 */
export function mountLiveRaid(hosts: LiveRaidHosts, deps: LiveRaidDeps): LiveRaidHandle {
  const { panel } = hosts;
  const importBox = panel.querySelector<HTMLElement>('[data-live-import]')!;
  const importStatus = panel.querySelector<HTMLElement>('[data-live-import-status]')!;
  const fileInput = panel.querySelector<HTMLInputElement>('[data-live-file]')!;
  const dropZone = panel.querySelector<HTMLElement>('[data-live-drop]')!;
  const board = panel.querySelector<HTMLElement>('[data-live-board]')!;
  const status = panel.querySelector<HTMLElement>('[data-live-status]')!;
  const phasesBox = panel.querySelector<HTMLElement>('[data-live-phases]')!;
  const overviewBox = panel.querySelector<HTMLElement>('[data-live-overview]')!;
  const bossesBox = panel.querySelector<HTMLElement>('[data-live-bosses]')!;
  const reimportButton = panel.querySelector<HTMLButtonElement>('[data-live-reimport]')!;
  const resetButton = panel.querySelector<HTMLButtonElement>('[data-live-reset]')!;

  let base: RaidPlannerInput | undefined;
  let fired: FiredShot[] = [];
  let plan: RaidPlannerPlan | undefined;
  let worker: Worker | undefined;
  let lastPendingKeys = new Set<string>();

  const persist = (): void => {
    try {
      if (base) localStorage.setItem(BASE_KEY, JSON.stringify(base));
      localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
    } catch { /* Storage can be unavailable. */ }
  };

  const restore = (): void => {
    try {
      const savedBase = localStorage.getItem(BASE_KEY);
      const savedFired = localStorage.getItem(FIRED_KEY);
      if (savedBase) base = JSON.parse(savedBase) as RaidPlannerInput;
      if (savedFired) fired = JSON.parse(savedFired) as FiredShot[];
    } catch { /* Corrupt storage must not block opening the tab. */ }
  };

  function resolve(): void {
    if (!base) return;
    worker?.terminate();
    const input: RaidPlannerInput = {
      phases: remainingPhases(base.phases, fired),
      candidates: remainingCandidates(base.candidates, fired),
      alreadyUsed: usedCounts(fired),
    };
    status.textContent = '正在重新計算…';
    const next = new Worker(new URL('./union-planner.worker.ts', import.meta.url), { type: 'module' });
    worker = next;
    next.addEventListener('message', (event: MessageEvent<{ kind: string; message?: string; plan?: RaidPlannerPlan }>) => {
      if (worker !== next) return;
      if (event.data.kind === 'progress') { status.textContent = event.data.message ?? ''; return; }
      next.terminate(); worker = undefined;
      if (event.data.kind === 'done' && event.data.plan) {
        const previous = lastPendingKeys;
        plan = event.data.plan;
        lastPendingKeys = new Set(plan.bars.flatMap((bar) => bar.shots.map(pendingKey)));
        status.textContent = '';
        renderAll(previous);
      } else {
        status.textContent = `重算失敗：${event.data.message ?? '未知錯誤'}`;
      }
    });
    next.addEventListener('error', (event) => {
      if (worker !== next) return;
      next.terminate(); worker = undefined;
      status.textContent = `重算失敗：${event.message}`;
    });
    next.postMessage(input);
  }

  function renderPhaseStepper(): void {
    phasesBox.replaceChildren();
    if (!plan) return;
    const now = currentPhaseIndex(plan);
    const row = el('div', 'live-phase-stepper');
    PHASE_LABELS.forEach((label, index) => {
      const state = index < now ? 'done' : index === now ? 'now' : 'todo';
      const mark = state === 'done' ? '✓' : state === 'now' ? '●' : '○';
      row.append(el('span', `live-phase-chip is-${state}`, `${label} ${mark}`));
      if (index < PHASE_LABELS.length - 1) row.append(el('span', 'live-phase-arrow', '→'));
    });
    phasesBox.append(row);
  }

  /** 사람마다 확정·대기를 왕별로 합쳐 총람 표를 만든다. */
  function renderOverview(): void {
    overviewBox.replaceChildren();
    if (!base) return;
    interface Row { memberId: string; memberName: string; perBoss: Map<number, { done: number; pending: number }>; used: number }
    const rows = new Map<string, Row>();
    const ensure = (memberId: string, memberName: string): Row => {
      let row = rows.get(memberId);
      if (!row) { row = { memberId, memberName, perBoss: new Map(), used: 0 }; rows.set(memberId, row); }
      return row;
    };
    for (const shot of fired) {
      const row = ensure(shot.memberId, shot.memberName);
      row.used += 1;
      const cell = row.perBoss.get(shot.bossIndex) ?? { done: 0, pending: 0 };
      cell.done += 1; row.perBoss.set(shot.bossIndex, cell);
    }
    if (plan) for (const member of plan.members) {
      const row = ensure(member.memberId, member.memberName);
      for (const shot of member.shots) {
        const cell = row.perBoss.get(shot.bossIndex) ?? { done: 0, pending: 0 };
        cell.pending += 1; row.perBoss.set(shot.bossIndex, cell);
      }
    }
    const bossNames = Array.from({ length: 5 }, (_, index) =>
      base!.candidates.find((c) => c.bossIndex === index)?.bossName || `第 ${index + 1} 王`);
    const active = [...rows.values()].filter((row) => row.used < 3
      || [...row.perBoss.values()].some((cell) => cell.pending > 0));
    const doneCount = rows.size - active.length;
    active.sort((a, b) => a.memberName.localeCompare(b.memberName));

    const table = el('table', 'live-overview-table');
    const head = el('tr');
    for (const label of ['成員', ...bossNames, '已出/上限']) head.append(el('th', undefined, label));
    table.append(head);
    for (const row of active) {
      const tr = el('tr');
      tr.append(el('th', undefined, row.memberName));
      for (let boss = 0; boss < 5; boss++) {
        const cell = row.perBoss.get(boss);
        const mark = !cell ? '·' : cell.pending > 0 ? `○${cell.done + cell.pending}/${cell.done + cell.pending}`
          : `✓${cell.done}/${cell.done}`;
        tr.append(el('td', undefined, mark));
      }
      tr.append(el('td', undefined, `${row.used}/3`));
      table.append(tr);
    }
    overviewBox.append(table);
    if (doneCount > 0) overviewBox.append(el('p', 'field-note', `已完成 ${doneCount} 人(全部出完，未列出)。`));
  }

  function renderConfirmedRow(shot: FiredShot, order: number, remainingAfter: number): HTMLElement {
    const row = el('div', 'live-shot-row is-done');
    row.append(el('span', 'live-shot-order', String(order)));
    row.append(el('span', 'live-shot-member', shot.memberName));
    row.append(squadPreview([shot.squad], deps.imageOf, deps.labelOf));
    row.append(el('span', 'live-shot-damage', yi(shot.damage)));
    row.append(el('span', 'live-shot-remain', `剩 ${yi(remainingAfter)}`));
    return row;
  }

  function renderPendingRow(shot: RaidPlannerShot, order: number, changed: boolean): HTMLElement {
    const row = el('div', 'live-shot-row is-pending' + (changed ? ' is-changed' : ''));
    row.append(el('span', 'live-shot-order', String(order)));
    row.append(el('span', 'live-shot-member', shot.memberName));
    if (changed) row.append(el('span', 'live-shot-flag', '🔄 剛重新分配'));

    // 이 사람이 이 왕에 아직 안 쏜 후보만 — 이미 확정된 (사람·왕·덱)을 또 고르면
    // 같은 조합이 두 번 나간 걸로 잡혀 혈량·한도 계산이 어긋난다.
    const options = remainingCandidates(base!.candidates, fired)
      .filter((c) => c.memberId === shot.memberId && c.bossIndex === shot.bossIndex);
    const preview = el('span', 'live-shot-preview');
    const deckSelect = el('select', 'live-deck-select');
    deckSelect.ariaLabel = `${shot.memberName} 實際隊伍`;
    for (const option of options) {
      const opt = document.createElement('option');
      opt.value = String(option.deckIndex);
      opt.textContent = `B${option.bossIndex + 1}-T${option.deckIndex + 1}`;
      if (option.deckIndex === shot.deckIndex) opt.selected = true;
      deckSelect.append(opt);
    }
    const damageInput = el('input', 'live-damage-input');
    damageInput.type = 'number'; damageInput.min = '0.01'; damageInput.step = '0.01';
    damageInput.ariaLabel = `${shot.memberName} 實際傷害（億）`;

    const drawPreview = (): void => {
      preview.replaceChildren();
      const picked = options.find((o) => String(o.deckIndex) === deckSelect.value);
      if (picked) preview.append(squadPreview([picked.squad], deps.imageOf, deps.labelOf));
      damageInput.value = picked ? (picked.damage / YI).toFixed(2) : '';
    };
    drawPreview();
    deckSelect.addEventListener('change', drawPreview);

    const confirm = el('button', 'roster-import', '確認並重算');
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      const picked = findCandidate(base!.candidates, shot.memberId, shot.bossIndex, Number(deckSelect.value));
      const damage = Number(damageInput.value);
      if (!picked || !Number.isFinite(damage) || damage <= 0) {
        status.textContent = '請選擇實際隊伍並填入大於 0 的傷害。';
        return;
      }
      fired.push({
        memberId: shot.memberId, memberName: shot.memberName, bossIndex: shot.bossIndex, bossName: shot.bossName,
        phase: shot.phase, deckIndex: picked.deckIndex, squad: picked.squad, damage: damage * YI,
      });
      persist();
      resolve();
    });

    row.append(preview, deckSelect, damageInput, confirm);
    return row;
  }

  function renderBossBlock(phase: number, bossIndex: number, previousKeys: Set<string>): HTMLElement {
    const bar = plan?.bars.find((entry) => entry.phase === phase && entry.bossIndex === bossIndex);
    const bossName = base!.candidates.find((c) => c.bossIndex === bossIndex)?.bossName || `第 ${bossIndex + 1} 王`;
    const confirmedHere = fired.filter((shot) => shot.phase === phase && shot.bossIndex === bossIndex);

    const wrap = el('details', 'live-boss-block');
    wrap.open = !(bar?.cleared ?? false);
    const summary = el('summary');
    if (bar?.cleared) {
      summary.textContent = `✓ ${bossName} · 已清 · 打完後剩餘 ${yi(bar.remaining ?? 0)}`;
    } else {
      const remain = bar ? yi(bar.remaining ?? 0) : '—';
      const left = bar?.shots.length ?? 0;
      summary.textContent = `${bossName} · 進行中 · 剩餘 ${remain}${left ? ` · 還差 ${left} 刀` : ''}`;
    }
    wrap.append(summary);

    const body = el('div', 'live-boss-body');
    let runningHp = base!.phases[phase]?.[bossIndex] ?? 0;
    confirmedHere.forEach((shot, index) => {
      runningHp = Math.max(0, runningHp - shot.damage);
      body.append(renderConfirmedRow(shot, index + 1, runningHp));
    });
    bar?.shots.forEach((shot, index) => {
      const changed = previousKeys.size > 0 && !previousKeys.has(pendingKey(shot));
      body.append(renderPendingRow(shot, confirmedHere.length + index + 1, changed));
    });
    if (!confirmedHere.length && !(bar?.shots.length)) body.append(el('p', 'field-note', '這一階段沒有排這個王的候選。'));
    wrap.append(body);
    return wrap;
  }

  function renderAll(previousKeys: Set<string>): void {
    renderPhaseStepper();
    renderOverview();
    bossesBox.replaceChildren();
    if (!plan) return;
    const now = currentPhaseIndex(plan);
    if (now === 3) {
      bossesBox.append(el('p', 'field-note', '三階段已全清，剩餘刀全部投入無限五王。下載最優出刀 CSV 可以看完整名單。'));
      return;
    }
    for (let bossIndex = 0; bossIndex < 5; bossIndex++) bossesBox.append(renderBossBlock(now, bossIndex, previousKeys));
  }

  function applyImport(text: string): void {
    try {
      const parsed = JSON.parse(text) as RaidPlannerInput;
      if (!Array.isArray(parsed.phases) || !Array.isArray(parsed.candidates) || !parsed.candidates.length) {
        throw new Error('empty');
      }
      base = parsed;
      fired = [];
      lastPendingKeys = new Set();
      plan = undefined;
      persist();
      importBox.hidden = true;
      board.hidden = false;
      importStatus.textContent = '';
      resolve();
    } catch {
      importStatus.textContent = '無法讀取這個檔案 — 請確認是聯盟戰分頁「匯出試算結果」存的 JSON。';
    }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void file.text().then(applyImport);
  });
  dropZone.addEventListener('dragover', (event) => event.preventDefault());
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void file.text().then(applyImport);
  });
  reimportButton.addEventListener('click', () => {
    importBox.hidden = false;
    board.hidden = true;
    importStatus.textContent = '';
  });
  resetButton.addEventListener('click', () => {
    if (!base) return;
    fired = [];
    lastPendingKeys = new Set();
    plan = undefined;
    persist();
    resolve();
  });

  restore();
  if (base) {
    importBox.hidden = true;
    board.hidden = false;
    resolve();
  }

  return {};
}
