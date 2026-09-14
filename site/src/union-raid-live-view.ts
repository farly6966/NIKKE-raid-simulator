import { squadPreview } from './share-panel';
import {
  memberAttackCapacity, type RaidPlannerCandidate, type RaidPlannerInput, type RaidPlannerPlan,
  type RaidPlannerShot,
} from './union-raid-planner';
import {
  actualPhaseIndex, findCandidate, remainingCandidates, remainingPhases, usedCounts, type FiredShot,
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
  const summaryBox = panel.querySelector<HTMLElement>('[data-live-summary]')!;
  const recorderBox = panel.querySelector<HTMLElement>('[data-live-recorder]')!;
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
    plan = undefined;
    status.textContent = '正在重新計算…';
    renderAll(lastPendingKeys);
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
        status.textContent = `重算失敗：${event.data.message ?? '未知錯誤'}（已確認的紀錄不會遺失，但暫時算不出新的建議出刀）`;
        renderAll(lastPendingKeys);
      }
    });
    next.addEventListener('error', (event) => {
      if (worker !== next) return;
      next.terminate(); worker = undefined;
      status.textContent = `重算失敗：${event.message}`;
      renderAll(lastPendingKeys);
    });
    next.postMessage(input);
  }

  const bossName = (bossIndex: number): string =>
    base?.candidates.find((candidate) => candidate.bossIndex === bossIndex)?.bossName || `第 ${bossIndex + 1} 王`;

  const currentPhase = (): number => base ? actualPhaseIndex(base.phases, fired) : 0;

  const capacityOf = (candidates: RaidPlannerCandidate[], subtractUsed: boolean): number => {
    const groups = new Map<string, RaidPlannerCandidate[]>();
    for (const candidate of candidates) {
      const rows = groups.get(candidate.memberId) ?? [];
      rows.push(candidate); groups.set(candidate.memberId, rows);
    }
    const used = usedCounts(fired);
    return [...groups.entries()].reduce((total, [memberId, rows]) => total + Math.min(
      memberAttackCapacity(rows), subtractUsed ? Math.max(0, 3 - (used[memberId] ?? 0)) : 3,
    ), 0);
  };

  function renderPhaseStepper(): void {
    phasesBox.replaceChildren();
    if (!base) return;
    const now = currentPhase();
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
  function renderSummary(): void {
    summaryBox.replaceChildren();
    if (!base) return;
    const now = currentPhase();
    const totalCapacity = capacityOf(base.candidates, false);
    const available = remainingCandidates(base.candidates, fired);
    const remainingCapacity = capacityOf(available, true);
    const remaining = remainingPhases(base.phases, fired);

    const metrics = el('div', 'live-metrics');
    const metric = (label: string, value: string): HTMLElement => {
      const card = el('div', 'live-metric');
      card.append(el('span', undefined, label), el('b', undefined, value));
      return card;
    };
    metrics.append(
      metric('目前階段', PHASE_LABELS[now]!),
      metric('已確認出刀', `${fired.length} / ${totalCapacity}`),
      metric('帳面剩餘刀', String(Math.max(0, totalCapacity - fired.length))),
      metric('仍有候選可排', String(remainingCapacity)),
      metric('重算狀態', plan ? '建議已更新' : '正在計算'),
    );
    summaryBox.append(metrics);

    const hpRow = el('div', 'live-hp-row');
    if (now === 3) {
      hpRow.append(el('span', 'live-hp-pill', `${bossName(4)} · 無限血量`));
    } else {
      remaining[now]!.forEach((hp, index) => {
        hpRow.append(el('span', `live-hp-pill${hp <= 0 ? ' is-cleared' : ''}`,
          `${bossName(index)} · ${hp <= 0 ? '已清' : `剩 ${yi(hp)}`}`));
      });
    }
    summaryBox.append(hpRow);

    const recommendation = el('div', 'live-recommendation');
    recommendation.append(el('b', undefined, '目前各王下一刀建議'));
    const suggested = plan?.bars.filter((bar) => bar.phase === now && bar.shots.length > 0)
      .map((bar) => bar.shots[0]!) ?? [];
    if (!suggested.length) {
      recommendation.append(el('span', 'field-note', plan
        ? '目前最佳解沒有分配這一階段；仍可用下方「記錄實際出刀」手動登記。'
        : '重算完成後會顯示；現在仍可先用下方表單登記。'));
    } else {
      const list = el('div', 'live-recommendation-list');
      for (const shot of suggested) {
        list.append(el('span', undefined,
          `${bossName(shot.bossIndex)} → ${shot.memberName} · T${shot.deckIndex + 1} · 預估 ${yi(shot.damage)}`));
      }
      recommendation.append(list);
    }
    summaryBox.append(recommendation);
  }

  function recordShot(candidate: RaidPlannerCandidate, phase: number, damageYi: number): boolean {
    if (!base || !Number.isFinite(damageYi) || damageYi <= 0) {
      status.textContent = '請選擇實際隊伍並填入大於 0 的傷害。';
      return false;
    }
    const available = remainingCandidates(base.candidates, fired).some((row) =>
      row.memberId === candidate.memberId && row.bossIndex === candidate.bossIndex
      && row.deckIndex === candidate.deckIndex);
    if (!available) {
      status.textContent = '這個隊伍已出刀或與已用角色重疊，請重新選擇。';
      renderAll(lastPendingKeys);
      return false;
    }
    fired.push({
      memberId: candidate.memberId, memberName: candidate.memberName,
      bossIndex: candidate.bossIndex, bossName: candidate.bossName,
      phase, deckIndex: candidate.deckIndex, squad: candidate.squad, damage: damageYi * YI,
    });
    persist();
    resolve();
    return true;
  }

  function renderRecorder(): void {
    recorderBox.replaceChildren();
    if (!base) return;
    const now = currentPhase();
    const card = el('section', 'live-recorder-card');
    const heading = el('div', 'live-recorder-heading');
    heading.append(el('h3', undefined, '記錄實際出刀'),
      el('p', 'field-note', '選誰、打哪隻王、實際用了哪隊，再填遊戲結算傷害（單位：億）。確認後立刻扣血、扣刀並重排。'));
    card.append(heading);

    const controls = el('div', 'live-recorder-controls');
    const labeled = (label: string, control: HTMLElement): HTMLElement => {
      const wrap = el('label', 'live-recorder-field');
      wrap.append(el('span', undefined, label), control);
      return wrap;
    };
    const bossSelect = el('select', 'live-recorder-select');
    bossSelect.ariaLabel = '實際攻擊 Boss';
    const currentHp = remainingPhases(base.phases, fired)[now];
    const bossIndexes = now === 3 ? [4] : Array.from({ length: 5 }, (_, index) => index)
      .filter((index) => (currentHp?.[index] ?? 0) > 0);
    for (const index of bossIndexes) {
      const option = document.createElement('option');
      option.value = String(index); option.textContent = bossName(index); bossSelect.append(option);
    }
    const memberSelect = el('select', 'live-recorder-select');
    memberSelect.ariaLabel = '實際出刀成員';
    const deckSelect = el('select', 'live-recorder-select');
    deckSelect.ariaLabel = '實際使用隊伍';
    const damageInput = el('input', 'live-damage-input');
    damageInput.type = 'number'; damageInput.min = '0.01'; damageInput.step = '0.01';
    damageInput.placeholder = '例如 523.4'; damageInput.ariaLabel = '實際傷害（億）';
    const preview = el('div', 'live-recorder-preview');

    const candidatesForSelection = (): RaidPlannerCandidate[] => remainingCandidates(base!.candidates, fired)
      .filter((candidate) => candidate.bossIndex === Number(bossSelect.value)
        && candidate.memberId === memberSelect.value);
    const updateDecks = (): void => {
      deckSelect.replaceChildren(); preview.replaceChildren();
      const options = candidatesForSelection();
      for (const candidate of options) {
        const option = document.createElement('option');
        option.value = String(candidate.deckIndex);
        option.textContent = `T${candidate.deckIndex + 1} · 預估 ${yi(candidate.damage)}`;
        deckSelect.append(option);
      }
      const picked = options[0];
      if (picked) {
        damageInput.value = (picked.damage / YI).toFixed(2);
        preview.append(squadPreview([picked.squad], deps.imageOf, deps.labelOf));
      } else damageInput.value = '';
    };
    const updateMembers = (): void => {
      memberSelect.replaceChildren();
      const boss = Number(bossSelect.value);
      const unique = new Map<string, string>();
      for (const candidate of remainingCandidates(base!.candidates, fired)) {
        if (candidate.bossIndex === boss) unique.set(candidate.memberId, candidate.memberName);
      }
      for (const [id, name] of [...unique.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
        const option = document.createElement('option'); option.value = id; option.textContent = name;
        memberSelect.append(option);
      }
      updateDecks();
    };
    const updatePreview = (): void => {
      preview.replaceChildren();
      const picked = candidatesForSelection().find((candidate) => candidate.deckIndex === Number(deckSelect.value));
      if (picked) {
        damageInput.value = (picked.damage / YI).toFixed(2);
        preview.append(squadPreview([picked.squad], deps.imageOf, deps.labelOf));
      }
    };
    bossSelect.addEventListener('change', updateMembers);
    memberSelect.addEventListener('change', updateDecks);
    deckSelect.addEventListener('change', updatePreview);
    updateMembers();

    const confirm = el('button', 'roster-import union-run', '確認這一刀並重算');
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      const picked = candidatesForSelection().find((candidate) => candidate.deckIndex === Number(deckSelect.value));
      if (picked) recordShot(picked, now, Number(damageInput.value));
      else status.textContent = '這位成員在這隻王沒有可用隊伍。';
    });
    controls.append(
      labeled('Boss', bossSelect), labeled('出刀成員', memberSelect), labeled('實際隊伍', deckSelect),
      labeled('實際傷害（億）', damageInput), confirm,
    );
    card.append(controls, preview);
    recorderBox.append(card);
  }

  function renderOverview(now: number): void {
    overviewBox.replaceChildren();
    if (!base) return;
    interface Row { memberId: string; memberName: string; perBoss: Map<number, { done: number; pending: number }>; used: number }
    const rows = new Map<string, Row>();
    const ensure = (memberId: string, memberName: string): Row => {
      let row = rows.get(memberId);
      if (!row) { row = { memberId, memberName, perBoss: new Map(), used: 0 }; rows.set(memberId, row); }
      return row;
    };
    for (const candidate of base.candidates) ensure(candidate.memberId, candidate.memberName);
    for (const shot of fired) {
      const row = ensure(shot.memberId, shot.memberName);
      row.used += 1;
      const cell = row.perBoss.get(shot.bossIndex) ?? { done: 0, pending: 0 };
      cell.done += 1; row.perBoss.set(shot.bossIndex, cell);
    }
    if (plan) for (const member of plan.members) {
      const row = ensure(member.memberId, member.memberName);
      for (const shot of member.shots.filter((candidate) => candidate.phase === now)) {
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
    const undo = el('button', 'roster-import live-undo', '撤銷此刀');
    undo.type = 'button';
    undo.addEventListener('click', () => {
      const index = fired.indexOf(shot);
      if (index >= 0) fired.splice(index, 1);
      persist(); resolve();
    });
    row.append(undo);
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
      recordShot(picked, shot.phase, damage);
    });

    row.append(preview, deckSelect, damageInput, confirm);
    return row;
  }

  function renderBossBlock(phase: number, bossIndex: number, previousKeys: Set<string>): HTMLElement {
    const bar = plan?.bars.find((entry) => entry.phase === phase && entry.bossIndex === bossIndex);
    const bossName = base!.candidates.find((c) => c.bossIndex === bossIndex)?.bossName || `第 ${bossIndex + 1} 王`;
    const confirmedHere = fired.filter((shot) => shot.phase === phase && shot.bossIndex === bossIndex);

    const trueRemaining = confirmedHere.reduce(
      (hp, shot) => Math.max(0, hp - shot.damage),
      base!.phases[phase]?.[bossIndex] ?? 0,
    );
    const trulyCleared = trueRemaining <= 0;

    const wrap = el('details', 'live-boss-block');
    wrap.open = !trulyCleared;
    const summary = el('summary');
    if (trulyCleared) {
      summary.textContent = `✓ ${bossName} · 已清 · 打完後剩餘 ${yi(trueRemaining)}`;
    } else {
      const left = bar?.shots.length ?? 0;
      summary.textContent = `${bossName} · 進行中 · 剩餘 ${yi(trueRemaining)}${left ? ` · 還差 ${left} 刀` : ''}`;
    }
    wrap.append(summary);

    const body = el('div', 'live-boss-body');
    let runningHp = base!.phases[phase]?.[bossIndex] ?? 0;
    confirmedHere.forEach((shot, index) => {
      runningHp = Math.max(0, runningHp - shot.damage);
      body.append(renderConfirmedRow(shot, index + 1, runningHp));
    });
    if (!trulyCleared) {
      bar?.shots.forEach((shot, index) => {
        const changed = previousKeys.size > 0 && !previousKeys.has(pendingKey(shot));
        body.append(renderPendingRow(shot, confirmedHere.length + index + 1, changed));
      });
    }
    if (!trulyCleared && !(bar?.shots.length)) {
      body.append(el('p', 'field-note', plan
        ? '目前最佳解沒有分配這隻王；可用上方「記錄實際出刀」手動選人與隊伍。'
        : '正在重算建議；可先用上方「記錄實際出刀」登記。'));
    }
    wrap.append(body);
    return wrap;
  }

  function renderAll(previousKeys: Set<string>): void {
    renderPhaseStepper();
    renderSummary();
    renderRecorder();
    const now = currentPhase();
    renderOverview(now);
    bossesBox.replaceChildren();
    if (now === 3) {
      bossesBox.append(el('p', 'field-note', '三階段已全清，現在可從上方登記無限五王的實際出刀；重算建議會持續更新。'));
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
      renderAll(lastPendingKeys);
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
    renderAll(lastPendingKeys);
    resolve();
  });

  restore();
  if (base) {
    importBox.hidden = true;
    board.hidden = false;
    renderAll(lastPendingKeys);
    resolve();
  }

  return {};
}
